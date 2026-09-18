require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const Stripe = require('stripe');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

app.use(express.json());
app.use(express.static('public')); 

const dbPath = path.join(__dirname, 'users.json');
let activeUsers = {};

// NEW: Track the global hardware state
let terminalIsOnline = false;

function loadUsers() {
  if (fs.existsSync(dbPath)) {
    const data = fs.readFileSync(dbPath, 'utf8');
    activeUsers = JSON.parse(data);
    console.log("Database loaded successfully.");
  } else {
    activeUsers = { "0000": { name: "Administrator", department: "Command Node", role: "admin" } };
    saveUsers();
    console.log("New database created with Master Admin.");
  }
}

function saveUsers() {
  fs.writeFileSync(dbPath, JSON.stringify(activeUsers, null, 2), 'utf8');
}

loadUsers(); 

app.post('/connection_token', async (req, res) => {
  try {
    const connectionToken = await stripe.terminal.connectionTokens.create();
    res.json({ secret: connectionToken.secret });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

io.on('connection', (socket) => {
  console.log('A device connected:', socket.id);
  
  // NEW: Instantly tell any new connection (like the Kiosk) the current hardware status
  socket.emit('terminal_status_update', { online: terminalIsOnline });

  // --- HARDWARE STATUS LOGIC ---
  socket.on('hardware_status', (data) => {
    socket.isHardwareTerminal = true; // Flag this specific socket as the Android phone
    
    // Only broadcast if the state actually changed to save bandwidth
    if (terminalIsOnline !== data.online) {
        terminalIsOnline = data.online;
        io.emit('terminal_status_update', { online: terminalIsOnline });
        console.log("Hardware Terminal Status Changed -> Online:", terminalIsOnline);
    }
  });

  socket.on('disconnect', () => {
    // If the Android phone completely drops its Wi-Fi connection, immediately mark it offline
    if (socket.isHardwareTerminal) {
      terminalIsOnline = false;
      io.emit('terminal_status_update', { online: terminalIsOnline });
      console.log("Hardware Terminal completely disconnected.");
    }
  });

  // --- AUTHENTICATION & ADMIN LOGIC ---
  socket.on('login_attempt', (pin) => {
    if (activeUsers[pin]) socket.emit('login_success', activeUsers[pin]);
    else socket.emit('login_failed', 'UNAUTHORIZED CREDENTIAL');
  });

  socket.on('register_user', (data) => {
    if (activeUsers[data.pin]) socket.emit('register_failed', 'PIN CODE ALREADY IN USE');
    else {
      activeUsers[data.pin] = { name: data.name, department: data.department, role: "user" };
      saveUsers(); socket.emit('register_success', 'PERSONNEL ADDED SECURELY');
    }
  });

  socket.on('get_users', () => { socket.emit('user_list', activeUsers); });

  socket.on('delete_user', (pin) => {
    if (pin !== '0000' && activeUsers[pin]) {
      delete activeUsers[pin]; saveUsers(); socket.emit('user_list', activeUsers); 
    }
  });

  socket.on('admin_command_terminal', (data) => {
    console.log("Admin issued hardware override:", data.command);
    io.emit('terminal_command', data);
  });

  // --- 1. CORPORATE CARD (NFC) LOGIC ---
  socket.on('create_charge', async (data) => {
    try {
      const intent = await stripe.paymentIntents.create({
        amount: data.amount, currency: 'gbp', payment_method_types: ['card_present'], capture_method: 'manual',
      });
      io.emit('wake_up_terminal', { client_secret: intent.client_secret, amount: data.amount });
    } catch (error) { socket.emit('payment_failed', 'Failed to initialize terminal.'); }
  });

  socket.on('payment_success', (data) => { io.emit('payment_success', data); });
  socket.on('payment_failed', (errorMsg) => { io.emit('payment_failed', errorMsg); });
  socket.on('cancel_payment', () => { io.emit('cancel_payment'); });

  // --- 2. DIGITAL WALLET (QR) LOGIC ---
  socket.on('qr_payment_confirmed', (data) => { io.emit('qr_payment_success', data); });
});

// Cloud providers use process.env.PORT, local testing falls back to 3000
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Salvation Inc. Server running on port ${PORT}`);
});