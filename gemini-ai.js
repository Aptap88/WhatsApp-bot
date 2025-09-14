const axios = require('axios');

class GeminiAI {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY || 'your-gemini-api-key-here';
    this.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent';
    this.conversationContext = new Map(); // Store conversation history per user
  }

  async generateResponse(userMessage, userName, chatHistory = []) {
    try {
      // Detect language from user message
      const detectedLanguage = this.detectLanguage(userMessage);
      
      // Build conversation context
      const context = this.buildContext(userName, chatHistory, detectedLanguage);
      
      // Prepare the prompt
      const prompt = this.buildPrompt(userMessage, context, detectedLanguage);
      
      const response = await axios.post(
        `${this.baseUrl}?key=${this.apiKey}`,
        {
          contents: [{
            parts: [{
              text: prompt
            }]
          }],
          generationConfig: {
            temperature: 0.9,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 200,
            stopSequences: []
          },
          safetySettings: [
            {
              category: "HARM_CATEGORY_HARASSMENT",
              threshold: "BLOCK_MEDIUM_AND_ABOVE"
            },
            {
              category: "HARM_CATEGORY_HATE_SPEECH",
              threshold: "BLOCK_MEDIUM_AND_ABOVE"
            }
          ]
        },
        {
          headers: {
            'Content-Type': 'application/json'
          },
          timeout: 10000 // 10 second timeout
        }
      );

      if (response.data?.candidates?.[0]?.content?.parts?.[0]?.text) {
        let aiResponse = response.data.candidates[0].content.parts[0].text.trim();
        
        // Post-process response
        aiResponse = this.postProcessResponse(aiResponse, detectedLanguage);
        
        // Update conversation context
        this.updateContext(userName, userMessage, aiResponse);
        
        return aiResponse;
      }
      
      return null;
      
    } catch (error) {
      console.error('❌ Gemini API error:', error.response?.data || error.message);
      return this.getFallbackResponse(this.detectLanguage(userMessage));
    }
  }

  detectLanguage(text) {
    // Hindi/Hinglish detection patterns
    const hindiPatterns = [
      /[\u0900-\u097F]/, // Hindi Unicode range
      /\b(hai|hain|kya|kaise|kab|kahan|kyun|aur|ya|ke|ki|ka|se|me|tum|aap|main|mein|hum|woh|yeh|iska|uska)\b/i,
      /\b(bhai|yaar|dost|boss|sir|madam|ji|sahab|bro|didi|bhabi|uncle|aunty)\b/i,
      /\b(achha|theek|sahi|galat|good|bad|nice|great|awesome|cool|ok|okay)\b/i,
      /\b(karo|karna|karne|kar|dekho|dekh|suno|sun|bolo|bol|jao|ja|aao|aa)\b/i
    ];

    // English patterns
    const englishPatterns = [
      /\b(the|and|or|but|in|on|at|to|for|of|with|by)\b/i,
      /\b(hello|hi|hey|thanks|thank|please|sorry|excuse|welcome)\b/i
    ];

    let hindiScore = 0;
    let englishScore = 0;

    hindiPatterns.forEach(pattern => {
      if (pattern.test(text)) hindiScore++;
    });

    englishPatterns.forEach(pattern => {
      if (pattern.test(text)) englishScore++;
    });

    // If Hindi patterns are found or mixed, return Hinglish
    if (hindiScore > 0 || (hindiScore === 0 && englishScore === 0)) {
      return 'hinglish';
    }
    
    return 'english';
  }

  buildContext(userName, chatHistory, language) {
    let context = '';
    
    if (chatHistory && chatHistory.length > 0) {
      context += 'Previous conversation:\n';
      chatHistory.forEach(msg => {
        const role = msg.isBot ? 'AI' : userName;
        context += `${role}: ${msg.body}\n`;
      });
      context += '\n';
    }

    return context;
  }

  buildPrompt(userMessage, context, language) {
    const personalityPrompt = language === 'hinglish' 
      ? `You are a friendly Indian friend who speaks naturally in Hinglish (Hindi + English mix). Reply like a close friend would - casual, warm, and helpful. Use common Hindi words naturally mixed with English. Keep responses short (1-2 sentences). Be conversational and use expressions like "yaar", "bhai", "achha", "theek hai", etc. Avoid being too formal or robotic.`
      : `You are a friendly and helpful assistant. Reply naturally and conversationally. Keep responses short and to the point (1-2 sentences). Be warm and personable.`;

    let prompt = personalityPrompt + '\n\n';
    
    if (context) {
      prompt += context;
    }
    
    prompt += `User message: "${userMessage}"\n\n`;
    prompt += `Reply naturally as a friend would:`;

    return prompt;
  }

  postProcessResponse(response, language) {
    // Remove common AI phrases
    const aiPhrases = [
      'As an AI', 'I am an AI', 'I\'m an AI assistant',
      'I cannot', 'I\'m not able to', 'I don\'t have the ability',
      'I apologize', 'I\'m sorry for any confusion'
    ];

    let cleanResponse = response;
    
    aiPhrases.forEach(phrase => {
      cleanResponse = cleanResponse.replace(new RegExp(phrase, 'gi'), '');
    });

    // Trim extra spaces and newlines
    cleanResponse = cleanResponse.trim().replace(/\n+/g, ' ');
    
    // Limit length
    if (cleanResponse.length > 300) {
      cleanResponse = cleanResponse.substring(0, 297) + '...';
    }

    // Add natural conversation starters if response is too short
    if (cleanResponse.length < 5) {
      return this.getFallbackResponse(language);
    }

    return cleanResponse;
  }

  updateContext(userName, userMessage, aiResponse) {
    const userContext = this.conversationContext.get(userName) || [];
    
    userContext.push({
      user: userMessage,
      ai: aiResponse,
      timestamp: new Date()
    });

    // Keep only last 3 exchanges to avoid token limits
    if (userContext.length > 3) {
      userContext.shift();
    }

    this.conversationContext.set(userName, userContext);
    
    // Clean old contexts (older than 1 hour)
    setTimeout(() => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      for (const [user, context] of this.conversationContext.entries()) {
        const filteredContext = context.filter(exchange => 
          new Date(exchange.timestamp) > oneHourAgo
        );
        
        if (filteredContext.length === 0) {
          this.conversationContext.delete(user);
        } else {
          this.conversationContext.set(user, filteredContext);
        }
      }
    }, 60000); // Clean every minute
  }

  getFallbackResponse(language) {
    const hinglishFallbacks = [
      "Haan bhai, bolo kya chahiye? 😊",
      "Acha, samajh gaya. Aur batao? 👍",
      "Theek hai yaar! Kya aur help chahiye? 🤔",
      "Sahi hai! Koi aur sawal? 😄",
      "Hmm interesting! Bolo aur kya puchna hai? 🤗",
      "Got it bro! Aur kuch help? 👌",
      "Nice yaar! Kya aur discuss karna hai? 💭",
      "Achha achha, samjha. Aur batao? 🙂"
    ];

    const englishFallbacks = [
      "Sure! What else can I help you with? 😊",
      "Got it! Anything else on your mind? 👍",
      "Understood! What would you like to know next? 🤔",
      "Alright! How can I assist you further? 😄",
      "I see! Any other questions? 🤗",
      "Perfect! What else can I do for you? 👌",
      "Cool! Anything else you'd like to discuss? 💭",
      "Great! What's next? 🙂"
    ];

    const fallbacks = language === 'hinglish' ? hinglishFallbacks : englishFallbacks;
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }

  // Method to handle specific conversation types
  async handleSpecialCommands(message, language) {
    const lowerMessage = message.toLowerCase();
    
    // Time related queries
    if (lowerMessage.includes('time') || lowerMessage.includes('samay')) {
      const now = new Date();
      const timeStr = now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      return language === 'hinglish' 
        ? `Abhi time hai ${timeStr} 🕐`
        : `Current time is ${timeStr} 🕐`;
    }

    // Date related queries
    if (lowerMessage.includes('date') || lowerMessage.includes('tareek')) {
      const today = new Date().toLocaleDateString('en-IN');
      return language === 'hinglish'
        ? `Aaj ki date hai ${today} 📅`
        : `Today's date is ${today} 📅`;
    }

    // Weather (mock response)
    if (lowerMessage.includes('weather') || lowerMessage.includes('mausam')) {
      return language === 'hinglish'
        ? "Weather ka exact data mere paas nahi hai yaar, weather app check karo! 🌤️"
        : "I don't have real-time weather data. Please check a weather app! 🌤️";
    }

    return null; // No special command matched
  }
}

module.exports = GeminiAI;
