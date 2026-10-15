const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const xlsx = require('xlsx');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcodeTerminal = require('qrcode-terminal');

// حماية السيرفر من التوقف عند أي تقطيع عابر في الإنترنت
process.on('unhandledRejection', (reason) => {
    console.error('⚠️ [تنبيه محمي] خطأ شبكة عابر وتم احتواؤه دون إيقاف السيرفر:', reason ? reason.message || reason : '');
});
process.on('uncaughtException', (err) => {
    console.error('⚠️ [استثناء محمي]:', err ? err.message || err : '');
});

const app = express();
const PORT = 3000;
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// مسار المتصفح المعتمد في جهازك
const chromePath = `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`;
const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const browserPath = fs.existsSync(chromePath) ? chromePath : edgePath;
console.log('المتصفح المعتمد للواتساب:', browserPath);

let isWhatsAppReady = false;
let latestQrCode = null;
let client;

let broadcastStatus = {
    isRunning: false,
    total: 0,
    current: 0,
    success: 0,
    failed: 0,
    statusText: 'لا توجد عملية إرسال حالياً'
};

function initWhatsAppClient() {
    isWhatsAppReady = false;
    latestQrCode = null;

    client = new Client({
        authStrategy: new LocalAuth({ dataPath: './school_auth' }),
        webVersionCache: {
            type: 'remote',
            remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        },
        takeoverOnConflict: true,
        puppeteer: {
            headless: true,
            executablePath: browserPath,
            timeout: 60000,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--remote-debugging-port=0',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-gpu'
            ]
        }
    });

    client.on('qr', (qr) => {
        latestQrCode = qr;
        isWhatsAppReady = false;
        console.log('\n=============================================');
        console.log('امسح رمز QR التالي من تطبيق واتساب بهاتفك:');
        console.log('=============================================\n');
        qrcodeTerminal.generate(qr, { small: true });
    });

    client.on('authenticated', () => {
        isWhatsAppReady = true;
        latestQrCode = null;
        console.log('✅ تم توثيق حساب الواتساب بنجاح!');
    });

    client.on('ready', () => {
        isWhatsAppReady = true;
        latestQrCode = null;
        console.log('✅ واتساب متصل وجاهز تماماً للإرسال!');
    });

    client.on('message_ack', (msg, ack) => {
        let status = 'sent';
        if (ack === 2) status = 'delivered';
        if (ack === 3) status = 'read';
        db.run(`UPDATE logs SET status = ? WHERE message_id = ?`, [status, msg.id.id]);
    });

    client.on('disconnected', () => {
        isWhatsAppReady = false;
        latestQrCode = null;
        setTimeout(() => {
            try { client.initialize(); } catch (e) {}
        }, 5000);
    });

    client.initialize().catch(err => {
        console.log('⚠️ جاري محاولة الربط بواتساب...');
    });
}

initWhatsAppClient();

// قاعدة البيانات وإنشاء الجداول
const db = new sqlite3.Database('./school.db');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS classrooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        guardian_name TEXT,
        phone TEXT NOT NULL,
        classroom TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT,
        student_name TEXT,
        phone TEXT,
        message TEXT,
        status TEXT,
        sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`ALTER TABLE logs ADD COLUMN message_id TEXT`, () => {});

    db.get("SELECT COUNT(*) as count FROM classrooms", (err, row) => {
        if (row && row.count === 0) {
            const defaultClasses = ['العاشر أ', 'العاشر ب', 'الحادي عشر علمي', 'الحادي عشر أدبي', 'الثاني عشر علمي', 'الثاني عشر أدبي'];
            const stmt = db.prepare("INSERT OR IGNORE INTO classrooms (name) VALUES (?)");
            defaultClasses.forEach(c => stmt.run(c));
            stmt.finalize();
        }
    });
});

app.get('/api/whatsapp-status', async (req, res) => {
    if (client && !isWhatsAppReady) {
        try {
            const state = await client.getState();
            if (state === 'CONNECTED') {
                isWhatsAppReady = true;
                latestQrCode = null;
            }
        } catch (e) {}
    }

    let status = 'INITIALIZING';
    if (isWhatsAppReady) {
        status = 'CONNECTED';
    } else if (latestQrCode) {
        status = 'SCAN_QR';
    }

    res.json({
        status: status,
        qr: latestQrCode
    });
});

app.get('/api/broadcast-status', (req, res) => {
    res.json(broadcastStatus);
});

app.get('/api/classrooms', (req, res) => {
    const sql = `
        SELECT c.id, c.name, COUNT(s.id) as student_count 
        FROM classrooms c 
        LEFT JOIN students s ON s.classroom = c.name 
        GROUP BY c.id, c.name 
        ORDER BY c.id ASC
    `;
    db.all(sql, [], (err, rows) => res.json(rows || []));
});

app.post('/api/classrooms', (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'اسم الشعبة مطلوب' });
    db.run(`INSERT INTO classrooms (name) VALUES (?)`, [name.trim()], function(err) {
        if (err) return res.status(400).json({ error: 'هذه الشعبة مضافة مسبقاً!' });
        res.json({ id: this.lastID });
    });
});

app.delete('/api/classrooms/:id', (req, res) => {
    db.run(`DELETE FROM classrooms WHERE id = ?`, [req.params.id], () => res.json({ success: true }));
});

app.get('/api/students', (req, res) => {
    db.all('SELECT * FROM students ORDER BY id DESC', [], (err, rows) => res.json(rows || []));
});

app.post('/api/students', (req, res) => {
    const { name, guardian_name, phone, classroom } = req.body;
    if (!name || !phone || !classroom) return res.status(400).json({ error: 'جميع الحقول مطلوبة' });
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    db.run(`INSERT INTO students (name, guardian_name, phone, classroom) VALUES (?, ?, ?, ?)`,
        [name, guardian_name, cleanPhone, classroom],
        function(err) { res.json({ id: this.lastID }); }
    );
});

app.delete('/api/students/:id', (req, res) => {
    db.run('DELETE FROM students WHERE id = ?', [req.params.id], () => res.json({ success: true }));
});

app.post('/api/students/delete-multiple', (req, res) => {
    const { ids } = req.body;
    if (!ids || !ids.length) return res.status(400).json({ error: 'لم يتم تحديد أي طالب' });
    const placeholders = ids.map(() => '?').join(',');
    db.run(`DELETE FROM students WHERE id IN (${placeholders})`, ids, function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: `تم حذف ${this.changes} طالب بنجاح` });
    });
});

app.post('/api/students/import-excel', upload.single('file'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'يرجى اختيار ملف إكسل' });

    try {
        const workbook = xlsx.read(req.file.buffer, { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const sheetData = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

        if (sheetData.length === 0) return res.status(400).json({ error: 'ملف الإكسل فارغ!' });

        let addedCount = 0;
        const stmt = db.prepare(`INSERT INTO students (name, guardian_name, phone, classroom) VALUES (?, ?, ?, ?)`);

        sheetData.forEach(row => {
            const name = row['اسم الطالب'] || row['الاسم'] || row['name'];
            const guardian = row['ولي الأمر'] || row['اسم ولي الأمر'] || row['guardian'] || '';
            const rawPhone = row['رقم الهاتف'] || row['رقم الواتساب'] || row['الجوال'] || row['phone'];
            const classroom = row['الصف'] || row['الشعبة'] || row['classroom'] || 'غير محدد';

            if (name && rawPhone) {
                const phone = String(rawPhone).replace(/[^0-9]/g, '');
                stmt.run(name, guardian, phone, classroom);
                addedCount++;
            }
        });

        stmt.finalize();
        res.json({ message: `تم استيراد ${addedCount} طالب بنجاح من ملف الإكسل!` });
    } catch (err) {
        res.status(500).json({ error: 'حدث خطأ أثناء قراءة ملف الإكسل' });
    }
});

app.get('/api/logs', (req, res) => {
    db.all('SELECT * FROM logs ORDER BY id DESC LIMIT 100', [], (err, rows) => res.json(rows || []));
});

async function getValidChatId(rawPhone) {
    let clean = rawPhone.replace(/[^0-9]/g, '');
    let candidates = [];
    if (clean.startsWith('05')) {
        candidates.push('970' + clean.substring(1));
        candidates.push('972' + clean.substring(1));
    } else if (clean.startsWith('5')) {
        candidates.push('970' + clean);
        candidates.push('972' + clean);
    } else {
        candidates.push(clean);
        if (clean.startsWith('970')) candidates.push('972' + clean.substring(3));
        if (clean.startsWith('972')) candidates.push('970' + clean.substring(3));
    }

    for (const num of candidates) {
        try {
            const numberId = await client.getNumberId(num);
            if (numberId) return numberId._serialized;
        } catch (e) {}
    }
    return null;
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

app.post('/api/send-bulk', async (req, res) => {
    if (!isWhatsAppReady) {
        return res.status(400).json({ error: 'واتساب غير متصل حالياً! يرجى مسح رمز QR أولاً.' });
    }

    if (broadcastStatus.isRunning) {
        return res.status(400).json({ error: 'هناك عملية إرسال جارية بالفعل في الخلفية!' });
    }

    const { targetType, targetClass, studentId, studentIds, messageTemplate } = req.body;
    let query = 'SELECT * FROM students';
    let params = [];

    if (targetType === 'classroom' && targetClass) {
        query += ' WHERE classroom = ?';
        params.push(targetClass);
    } else if (targetType === 'single' && studentId) {
        query += ' WHERE id = ?';
        params.push(studentId);
    } else if (targetType === 'custom' && Array.isArray(studentIds) && studentIds.length > 0) {
        const placeholders = studentIds.map(() => '?').join(',');
        query += ` WHERE id IN (${placeholders})`;
        params = studentIds;
    }

    db.all(query, params, async (err, students) => {
        if (!students || students.length === 0) {
            return res.status(404).json({ error: 'لم يتم العثور على أي طالب مطابق للاختيار المحدد' });
        }

        res.json({ message: `تمت جدولة إرسال الرسائل لـ ${students.length} طالب.` });

        broadcastStatus = {
            isRunning: true,
            total: students.length,
            current: 0,
            success: 0,
            failed: 0,
            statusText: `جارٍ الإرسال الآمن لـ ${students.length} طالب...`
        };

        for (let i = 0; i < students.length; i++) {
            const student = students[i];
            broadcastStatus.current = i + 1;

            let msg = messageTemplate
                .replace(/{student_name}/g, student.name)
                .replace(/{guardian_name}/g, student.guardian_name || 'ولي الأمر المحترم')
                .replace(/{classroom}/g, student.classroom);

            const validChatId = await getValidChatId(student.phone);

            if (!validChatId) {
                broadcastStatus.failed++;
                db.run(`INSERT INTO logs (student_name, phone, message, status) VALUES (?, ?, ?, 'failed_no_whatsapp')`,
                    [student.name, student.phone, msg]);
                continue;
            }

            try {
                const randomDelay = Math.floor(Math.random() * 3000) + 3000;
                await sleep(randomDelay);

                const sentMsg = await client.sendMessage(validChatId, msg);
                broadcastStatus.success++;
                db.run(`INSERT INTO logs (message_id, student_name, phone, message, status) VALUES (?, ?, ?, ?, 'sent')`,
                    [sentMsg.id.id, student.name, student.phone, msg]);
            } catch (error) {
                broadcastStatus.failed++;
                db.run(`INSERT INTO logs (student_name, phone, message, status) VALUES (?, ?, ?, 'failed')`,
                    [student.name, student.phone, msg]);
            }

            if ((i + 1) % 25 === 0 && (i + 1) < students.length) {
                broadcastStatus.statusText = `استراحة تبريد أمان (40 ثانية) لحماية الرقم بعد إرسال ${i + 1} رسالة...`;
                await sleep(40000);
            }
        }

        broadcastStatus.isRunning = false;
        broadcastStatus.statusText = `اكتملت الحملة بنجاح! تم إرسال ${broadcastStatus.success} رسالة.`;
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`سيرفر مدرسة الأوائل الخاصة يعمل الآن على المنفذ: ${PORT}`);
});