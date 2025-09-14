const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const WhatsAppHandler = require('./whatsapp-handler');
const Database = require('./database');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP'
});
app.use(limiter);

// Global variables
const activeSessions = new Map();
const db = new Database();

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date().toISOString(),
    activeSessions: activeSessions.size,
    uptime: process.uptime()
  });
});

// API Routes
app.get('/api/stats', async (req, res) => {
  try {
    const stats = await db.getStats();
    res.json({
      success: true,
      data: {
        totalSessions: activeSessions.size,
        totalMessages: stats.totalMessages || 0,
        uptime: process.uptime()
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/send-message', async (req, res) => {
  try {
    const { sessionId, to, message } = req.body;
    
    if (!sessionId || !to || !message) {
      return res.status(400).json({ 
        success: false, 
        error: 'Missing required fields: sessionId, to, message' 
      });
    }

    const session = activeSessions.get(sessionId);
    if (!session || !session.client) {
      return res.status(404).json({ 
        success: false, 
        error: 'Session not found or not ready' 
      });
    }

    await session.handler.sendMessage(to, message);
    res.json({ success: true, message: 'Message sent successfully' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log(`🔗 Client connected: ${socket.id}`);

  socket.on('start-session', async () => {
    try {
      const sessionId = generateSessionId();
      console.log(`🚀 Starting WhatsApp session: ${sessionId}`);
      
      const whatsappHandler = new WhatsAppHandler(sessionId, socket, db);
      
      // Store session
      activeSessions.set(sessionId, {
        id: sessionId,
        handler: whatsappHandler,
        client: null,
        socket: socket,
        startTime: new Date()
      });

      // Initialize WhatsApp client
      await whatsappHandler.initialize();
      
    } catch (error) {
      console.error('❌ Session start error:', error);
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('stop-session', async (data) => {
    try {
      const sessionId = data.sessionId;
      const session = activeSessions.get(sessionId);
      
      if (session) {
        console.log(`⏹️ Stopping session: ${sessionId}`);
        await session.handler.destroy();
        activeSessions.delete(sessionId);
        socket.emit('disconnected');
      }
    } catch (error) {
      console.error('❌ Session stop error:', error);
      socket.emit('error', { message: error.message });
    }
  });

  socket.on('disconnect', async () => {
    console.log(`🔌 Client disconnected: ${socket.id}`);
    
    // Clean up sessions for this socket
    for (const [sessionId, session] of activeSessions.entries()) {
      if (session.socket.id === socket.id) {
        try {
          await session.handler.destroy();
          activeSessions.delete(sessionId);
          console.log(`🧹 Cleaned up session: ${sessionId}`);
        } catch (error) {
          console.error('❌ Cleanup error:', error);
        }
      }
    }
  });
});

// Utility functions
function generateSessionId() {
  return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM received, shutting down gracefully...');
  
  // Close all active sessions
  for (const [sessionId, session] of activeSessions.entries()) {
    try {
      await session.handler.destroy();
    } catch (error) {
      console.error(`❌ Error closing session ${sessionId}:`, error);
    }
  }
  
  // Close database connection
  await db.close();
  
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', async () => {
  console.log('🛑 SIGINT received, shutting down gracefully...');
  
  for (const [sessionId, session] of activeSessions.entries()) {
    try {
      await session.handler.destroy();
    } catch (error) {
      console.error(`❌ Error closing session ${sessionId}:`, error);
    }
  }
  
  await db.close();
  process.exit(0);
});

// Error handling
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled Rejection at:', promise, 'reason:', reason);
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🚀 WhatsApp Auto Bot Server running on port ${PORT}`);
  console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💾 Database: ${process.env.DB_HOST}:${process.env.DB_PORT}`);
});

module.exports = { app, io, activeSessions };
