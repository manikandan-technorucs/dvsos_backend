const { Server } = require('socket.io');
const env = require('./env');

let io;

const initializeSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: true,
      credentials: true
    }
  });

  io.on('connection', (socket) => {
    console.info(`Socket connected: ${socket.id}`);

    socket.on('join_user_room', (userId) => {
      if (userId) {
        socket.join(`user:${userId}`);
        console.info(`[Socket] User ${userId} joined room user:${userId} (socket: ${socket.id})`);
      }
    });

    socket.on('join_chat_room', (jobCardId) => {
      if (jobCardId) {
        socket.join(`chat:job_card_${jobCardId}`);
        console.info(`[Socket] Joined chat room chat:job_card_${jobCardId} (socket: ${socket.id})`);
      }
    });

    socket.on('leave_chat_room', (jobCardId) => {
      if (jobCardId) {
        socket.leave(`chat:job_card_${jobCardId}`);
        console.info(`[Socket] Left chat room chat:job_card_${jobCardId} (socket: ${socket.id})`);
      }
    });

    socket.on('disconnect', () => {
      console.info(`Socket disconnected: ${socket.id}`);
    });
  });

  return io;
};

const getSocket = () => io;

module.exports = {
  initializeSocket,
  getSocket
};
