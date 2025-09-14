const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const GeminiAI = require('./gemini-ai');

class WhatsAppHandler {
  constructor(sessionId, socket, database) {
    this.sessionId = sessionId;
    this.socket = socket;
    this.database = database;
    this.client = null;
    this.geminiAI = new GeminiAI();
    this.isReady = false;
    this.messageQueue = new Map(); // Rate limiting
    this.lastActivity = new Date();
  }

  async initialize() {
    try {
      console.log(`🔄 Initializing WhatsApp client for session: ${this.sessionId}`);
      
      this.client = new Client({
        authStrategy: new LocalAuth({ 
          clientId: this.sessionId,
          dataPath: './.wwebjs_auth'
        }),
        puppeteer: {
          headless: true,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu'
          ]
        }
      });

      this.setupEventListeners();
      await this.client.initialize();
      
    } catch (error) {
      console.error('❌ WhatsApp initialization error:', error);
      this.socket.emit('error', { message: 'Failed to initialize WhatsApp: ' + error.message });
    }
  }

  setupEventListeners() {
    // QR Code generation
    this.client.on('qr', async (qr) => {
      try {
        console.log('📱 QR Code generated for session:', this.sessionId);
        const qrImage = await qrcode.toDataURL(qr, { width: 256 });
        this.socket.emit('qr', qrImage);
      } catch (error) {
        console.error('❌ QR generation error:', error);
        this.socket.emit('error', { message: 'QR code generation failed' });
      }
    });

    // Client ready
    this.client.on('ready', async () => {
      console.log('✅ WhatsApp client is ready for session:', this.sessionId);
      this.isReady = true;
      
      const clientInfo = this.client.info;
      this.socket.emit('ready', {
        sessionId: this.sessionId,
        phone: clientInfo.wid.user,
        name: clientInfo.pushname
      });

      // Save session to database
      await this.database.saveSession(this.sessionId, {
        phone: clientInfo.wid.user,
        name: clientInfo.pushname,
        status: 'active'
      });
    });

    // Authentication state changes
    this.client.on('auth_failure', (message) => {
      console.error('❌ Authentication failed:', message);
      this.socket.emit('error', { message: 'Authentication failed: ' + message });
    });

    this.client.on('authenticated', () => {
      console.log('🔐 WhatsApp authenticated for session:', this.sessionId);
    });

    // Disconnection handling
    this.client.on('disconnected', (reason) => {
      console.log('🔌 WhatsApp disconnected:', reason);
      this.isReady = false;
      this.socket.emit('disconnected');
    });

    // Message handling
    this.client.on('message', async (message) => {
      await this.handleIncomingMessage(message);
    });

    // Group message handling
    this.client.on('message_create', async (message) => {
      if (message.fromMe) return; // Ignore own messages
      await this.handleIncomingMessage(message);
    });
  }

  async handleIncomingMessage(message) {
    try {
      // Skip if not ready or if it's a status message
      if (!this.isReady || message.type === 'e2e_notification') return;
      
      const chat = await message.getChat();
      const contact = await message.getContact();
      
      // Skip groups for now (optional: can be enabled)
      if (chat.isGroup) {
        console.log('📨 Group message skipped from:', chat.name);
        return;
      }

      const messageData = {
        id: message.id._serialized,
        from: contact.name || contact.pushname || contact.number,
        phone: contact.number,
        body: message.body,
        type: message.type,
        timestamp: new Date(message.timestamp * 1000),
        chatId: chat.id._serialized
      };

      console.log(`📨 New message from ${messageData.from}: ${messageData.body}`);

      // Rate limiting check
      if (this.isRateLimited(messageData.phone)) {
        console.log('⚠️ Rate limited user:', messageData.phone);
        return;
      }

      // Save message to database
      await this.database.saveMessage(this.sessionId, messageData);

      // Emit to frontend
      this.socket.emit('message', messageData);

      // Generate AI response
      await this.processAndReply(message, messageData);

    } catch (error) {
      console.error('❌ Message handling error:', error);
    }
  }

  async processAndReply(message, messageData) {
    try {
      // Get chat history for context
      const chatHistory = await this.database.getChatHistory(messageData.phone, 5);
      
      // Generate AI response
      const aiResponse = await this.geminiAI.generateResponse(
        messageData.body, 
        messageData.from,
        chatHistory
      );

      if (aiResponse) {
        // Simulate human typing
        await this.simulateTyping(message);
        
        // Send response
        await message.reply(aiResponse);
        
        // Save AI response to database
        await this.database.saveMessage(this.sessionId, {
          id: `bot_${Date.now()}`,
          from: 'AI Bot',
          phone: 'system',
          body: aiResponse,
          type: 'chat',
          timestamp: new Date(),
          chatId: messageData.chatId,
          isBot: true
        });

        console.log(`🤖 AI replied to ${messageData.from}: ${aiResponse.substring(0, 50)}...`);
      }

    } catch (error) {
      console.error('❌ AI response error:', error);
      
      // Fallback response
      const fallbackMessage = this.getFallbackMessage();
      try {
        await message.reply(fallbackMessage);
      } catch (replyError) {
        console.error('❌ Fallback reply error:', replyError);
      }
    }
  }

  async simulateTyping(message) {
    try {
      const chat = await message.getChat();
      
      // Start typing
      await chat.sendStateTyping();
      
      // Random delay between 1-3 seconds (human-like)
      const delay = Math.floor(Math.random() * 2000) + 1000;
      await this.sleep(delay);
      
      // Stop typing
      await chat.clearState();
      
    } catch (error) {
      console.error('❌ Typing simulation error:', error);
    }
  }

  isRateLimited(phone) {
    const now = Date.now();
    const userQueue = this.messageQueue.get(phone);
    
    if (!userQueue) {
      this.messageQueue.set(phone, [now]);
      return false;
    }

    // Remove messages older than 1 minute
    const filtered = userQueue.filter(timestamp => now - timestamp < 60000);
    
    // Allow max 2 messages per minute
    if (filtered.length >= 2) {
      return true;
    }

    filtered.push(now);
    this.messageQueue.set(phone, filtered);
    return false;
  }

  getFallbackMessage() {
    const fallbacks = [
      "Sorry yaar, thoda issue ho gaya. Tum bolo kya chahiye? 😅",
      "Arre bhai, ek minute... thoda confusion hai. Dubara try karo! 🤔",
      "Oops! Lagta hai network issue hai. Kya keh rahe the? 🤖",
      "Sorry boss, samajh nahi aaya. Aur batao kya help chahiye? 🤷‍♂️"
    ];
    
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  async sendMessage(to, message) {
    try {
      if (!this.isReady) {
        throw new Error('WhatsApp client is not ready');
      }

      const chatId = to.includes('@') ? to : `${to}@c.us`;
      await this.client.sendMessage(chatId, message);
      
      console.log(`📤 Message sent to ${to}: ${message}`);
      return true;
      
    } catch (error) {
      console.error('❌ Send message error:', error);
      throw error;
    }
  }

  async destroy() {
    try {
      if (this.client) {
        console.log(`🔄 Destroying WhatsApp client for session: ${this.sessionId}`);
        await this.client.destroy();
        this.client = null;
        this.isReady = false;
      }
    } catch (error) {
      console.error('❌ Client destruction error:', error);
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = WhatsAppHandler;
