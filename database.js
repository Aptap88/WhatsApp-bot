const mysql = require('mysql2/promise');

class Database {
  constructor() {
    this.connection = null;
    this.config = {
      host: process.env.DB_HOST || 'cashearnersofficial.xyz',
      user: process.env.DB_USER || 'cztldhwx_Auto_PostTg',
      password: process.env.DB_PASSWORD || 'Aptap786920',
      database: process.env.DB_NAME || 'cztldhwx_Auto_PostTg',
      port: process.env.DB_PORT || 3306,
      connectTimeout: 60000,
      supportBigNumbers: true,
      bigNumberStrings: true
    };
    
    this.initializeDatabase();
  }

  async initializeDatabase() {
    try {
      this.connection = await mysql.createConnection(this.config);
      console.log('✅ MySQL Database connected successfully');
      
      // Create tables if they don't exist
      await this.createTables();
      
    } catch (error) {
      console.error('❌ Database connection error:', error);
      // Retry connection after 5 seconds
      setTimeout(() => this.initializeDatabase(), 5000);
    }
  }

  async createTables() {
    try {
      // Sessions table
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS whatsapp_sessions (
          id VARCHAR(100) PRIMARY KEY,
          phone VARCHAR(20),
          name VARCHAR(100),
          status ENUM('active', 'inactive', 'expired') DEFAULT 'active',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_phone (phone),
          INDEX idx_status (status)
        )
      `);

      // Messages table
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS whatsapp_messages (
          id VARCHAR(200) PRIMARY KEY,
          session_id VARCHAR(100),
          from_name VARCHAR(100),
          from_phone VARCHAR(20),
          message_body TEXT,
          message_type VARCHAR(20) DEFAULT 'chat',
          chat_id VARCHAR(200),
          is_bot BOOLEAN DEFAULT FALSE,
          timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(id) ON DELETE CASCADE,
          INDEX idx_session (session_id),
          INDEX idx_phone (from_phone),
          INDEX idx_timestamp (timestamp),
          INDEX idx_chat_id (chat_id)
        )
      `);

      // Statistics table
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS bot_statistics (
          id INT AUTO_INCREMENT PRIMARY KEY,
          session_id VARCHAR(100),
          total_messages INT DEFAULT 0,
          total_replies INT DEFAULT 0,
          active_chats INT DEFAULT 0,
          date DATE DEFAULT (CURRENT_DATE),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY unique_session_date (session_id, date),
          FOREIGN KEY (session_id) REFERENCES whatsapp_sessions(id) ON DELETE CASCADE
        )
      `);

      // User preferences table
      await this.connection.execute(`
        CREATE TABLE IF NOT EXISTS user_preferences (
          id INT AUTO_INCREMENT PRIMARY KEY,
          phone VARCHAR(20) UNIQUE,
          preferred_language VARCHAR(20) DEFAULT 'hinglish',
          auto_reply BOOLEAN DEFAULT TRUE,
          last_interaction TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          INDEX idx_phone (phone)
        )
      `);

      console.log('✅ Database tables created successfully');
      
    } catch (error) {
      console.error('❌ Table creation error:', error);
    }
  }

  async saveSession(sessionId, sessionData) {
    try {
      await this.connection.execute(`
        INSERT INTO whatsapp_sessions (id, phone, name, status) 
        VALUES (?, ?, ?, 'active')
        ON DUPLICATE KEY UPDATE 
        phone = VALUES(phone),
        name = VALUES(name),
        status = VALUES(status),
        updated_at = CURRENT_TIMESTAMP
      `, [sessionId, sessionData.phone, sessionData.name]);
      
      console.log(`✅ Session saved: ${sessionId}`);
      
    } catch (error) {
      console.error('❌ Save session error:', error);
    }
  }

  async saveMessage(sessionId, messageData) {
    try {
      await this.connection.execute(`
        INSERT INTO whatsapp_messages 
        (id, session_id, from_name, from_phone, message_body, message_type, chat_id, is_bot, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
        message_body = VALUES(message_body),
        timestamp = VALUES(timestamp)
      `, [
        messageData.id,
        sessionId,
        messageData.from,
        messageData.phone,
        messageData.body,
        messageData.type,
        messageData.chatId,
        messageData.isBot || false,
        messageData.timestamp
      ]);

      // Update statistics
      await this.updateStatistics(sessionId, messageData.isBot);
      
    } catch (error) {
      console.error('❌ Save message error:', error);
    }
  }

  async getChatHistory(phone, limit = 5) {
    try {
      const [rows] = await this.connection.execute(`
        SELECT from_name, message_body, is_bot, timestamp
        FROM whatsapp_messages 
        WHERE from_phone = ? 
        ORDER BY timestamp DESC 
        LIMIT ?
      `, [phone, limit]);

      return rows.reverse().map(row => ({
        from: row.from_name,
        body: row.message_body,
        isBot: row.is_bot,
        timestamp: row.timestamp
      }));
      
    } catch (error) {
      console.error('❌ Get chat history error:', error);
      return [];
    }
  }

  async updateStatistics(sessionId, isBot = false) {
    try {
      if (isBot) {
        await this.connection.execute(`
          INSERT INTO bot_statistics (session_id, total_replies) 
          VALUES (?, 1)
          ON DUPLICATE KEY UPDATE 
          total_replies = total_replies + 1,
          updated_at = CURRENT_TIMESTAMP
        `, [sessionId]);
      } else {
        await this.connection.execute(`
          INSERT INTO bot_statistics (session_id, total_messages) 
          VALUES (?, 1)
          ON DUPLICATE KEY UPDATE 
          total_messages = total_messages + 1,
          updated_at = CURRENT_TIMESTAMP
        `, [sessionId]);
      }
      
    } catch (error) {
      console.error('❌ Update statistics error:', error);
    }
  }

  async getStats() {
    try {
      const [sessionStats] = await this.connection.execute(`
        SELECT 
          COUNT(*) as totalSessions,
          COUNT(CASE WHEN status = 'active' THEN 1 END) as activeSessions
        FROM whatsapp_sessions
      `);

      const [messageStats] = await this.connection.execute(`
        SELECT 
          COUNT(*) as totalMessages,
          COUNT(CASE WHEN is_bot = true THEN 1 END) as botReplies,
          COUNT(DISTINCT from_phone) as uniqueUsers
        FROM whatsapp_messages
        WHERE DATE(created_at) = CURDATE()
      `);

      return {
        totalSessions: sessionStats[0]?.totalSessions || 0,
        activeSessions: sessionStats[0]?.activeSessions || 0,
        totalMessages: messageStats[0]?.totalMessages || 0,
        botReplies: messageStats[0]?.botReplies || 0,
        uniqueUsers: messageStats[0]?.uniqueUsers || 0
      };
      
    } catch (error) {
      console.error('❌ Get stats error:', error);
      return {};
    }
  }

  async getUserPreferences(phone) {
    try {
      const [rows] = await this.connection.execute(`
        SELECT preferred_language, auto_reply 
        FROM user_preferences 
        WHERE phone = ?
      `, [phone]);

      if (rows.length > 0) {
        return rows[0];
      }

      // Create default preferences
      await this.connection.execute(`
        INSERT INTO user_preferences (phone, preferred_language, auto_reply)
        VALUES (?, 'hinglish', true)
      `, [phone]);

      return { preferred_language: 'hinglish', auto_reply: true };
      
    } catch (error) {
      console.error('❌ Get user preferences error:', error);
      return { preferred_language: 'hinglish', auto_reply: true };
    }
  }

  async updateUserPreferences(phone, preferences) {
    try {
      await this.connection.execute(`
        INSERT INTO user_preferences (phone, preferred_language, auto_reply, last_interaction)
        VALUES (?, ?, ?, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
        preferred_language = VALUES(preferred_language),
        auto_reply = VALUES(auto_reply),
        last_interaction = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
      `, [phone, preferences.language, preferences.autoReply]);
      
    } catch (error) {
      console.error('❌ Update user preferences error:', error);
    }
  }

  async cleanupOldSessions(days = 7) {
    try {
      await this.connection.execute(`
        UPDATE whatsapp_sessions 
        SET status = 'expired' 
        WHERE status = 'active' 
        AND updated_at < DATE_SUB(NOW(), INTERVAL ? DAY)
      `, [days]);

      const [result] = await this.connection.execute(`
        DELETE FROM whatsapp_messages 
        WHERE created_at < DATE_SUB(NOW(), INTERVAL ? DAY)
      `, [days * 2]); // Keep messages for double the session period

      console.log(`🧹 Cleaned up ${result.affectedRows} old messages`);
      
    } catch (error) {
      console.error('❌ Cleanup error:', error);
    }
  }

  async close() {
    try {
      if (this.connection) {
        await this.connection.end();
        console.log('✅ Database connection closed');
      }
    } catch (error) {
      console.error('❌ Database close error:', error);
    }
  }

  // Health check method
  async healthCheck() {
    try {
      await this.connection.execute('SELECT 1');
      return { status: 'healthy' };
    } catch (error) {
      console.error('❌ Database health check failed:', error);
      return { status: 'unhealthy', error: error.message };
    }
  }
}

module.exports = Database;
