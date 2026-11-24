const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const WEAPONS = [
  "سكين مطبخ", "مسدس كاتم", "سم السيانيد", "حبل غسيل", "مطرقة ثقيلة",
  "إبرة طبية", "وسادة", "مقص حاد", "زجاجة مكسورة", "مضرب بيسبول",
  "سلك كهربائي", "فأس صغير", "عصا غولف", "مشرط جراحي", "قنبلة يدوية",
  "بندقية صيد", "خنجر أثري", "غاز سام", "صخرة كبيرة", "مفك براغي"
];

const EVIDENCE = [
  "بصمة إصبع", "خصلة شعر", "بقعة دم", "رسالة ممزقة", "زر قميص",
  "أثر حذاء", "ساعة مكسورة", "عطر نسائي", "رماد سيجارة", "خاتم ذهبي",
  "تذكرة سفر", "هاتف محطم", "مفتاح قديم", "قطعة قماش", "فاتورة شراء",
  "نظارة طبية", "كاميرا مراقبة", "قلادة فضية", "منديل مبلل", "محفظة نقود"
];

const FORENSIC_CARDS = [
  { title: "سبب الوفاة", options: ["اختناق", "نزيف حاد", "تسمم", "صدمة قوية", "حروق", "غير محدد"] },
  { title: "موقع الجريمة", options: ["غرفة النوم", "المطبخ", "الحديقة", "المكتب", "السيارة", "القبو"] },
  { title: "وقت الجريمة", options: ["الفجر", "الصباح", "الظهيرة", "المساء", "منتصف الليل", "غير معروف"] },
  { title: "حالة الجثة", options: ["مقيدة", "مخفية", "مشوهة", "سليمة ظاهرياً", "مبتلة", "محترقة"] },
  { title: "الطقس أثناء الجريمة", options: ["ممطر", "عاصف", "حار جداً", "بارد", "ضبابي", "صافي"] },
  { title: "شخصية القاتل", options: ["متوتر", "هادئ وبارد", "متسرع", "ذكي ومخطط", "غاضب", "مضطرب"] }
];

let rooms = {};

function shuffle(array) {
  return [...array].sort(() => Math.random() - 0.5);
}

io.on('connection', (socket) => {
  socket.on('joinRoom', ({ roomCode, playerName }) => {
    socket.join(roomCode);
    if (!rooms[roomCode]) {
      rooms[roomCode] = { players: [], state: 'lobby', solution: null, hints: [] };
    }
    const room = rooms[roomCode];
    if (room.players.length >= 6) {
      socket.emit('errorMsg', 'الغرفة ممتلئة (الحد الأقصى 6 لاعبين)');
      return;
    }
    room.players.push({ id: socket.id, name: playerName, role: '', weapons: [], evidence: [] });
    io.to(roomCode).emit('updatePlayers', room.players);
  });

  // نظام الدردشة
  socket.on('sendChat', ({ roomCode, sender, text }) => {
    io.to(roomCode).emit('newChat', { sender, text });
  });

  socket.on('startGame', (roomCode) => {
    const room = rooms[roomCode];
    if (!room || room.players.length !== 6) {
      socket.emit('errorMsg', 'يجب وجود 6 لاعبين بالضبط لبدء اللعبة!');
      return;
    }

    const roles = shuffle(['الطبيب الشرعي', 'القاتل', 'الشريك', 'شاهد العيان', 'محقق', 'محقق']);
    const shuffledWeapons = shuffle(WEAPONS);
    const shuffledEvidence = shuffle(EVIDENCE);

    room.players.forEach((player, index) => {
      player.role = roles[index];
      if (player.role !== 'الطبيب الشرعي') {
        player.weapons = shuffledWeapons.splice(0, 4);
        player.evidence = shuffledEvidence.splice(0, 4);
      }
    });

    room.state = 'murder_selection';
    room.hints = shuffle(FORENSIC_CARDS).slice(0, 4).map(c => ({ ...c, selected: null }));

    room.players.forEach((p) => {
      const killer = room.players.find(x => x.role === 'القاتل');
      const accomplice = room.players.find(x => x.role === 'الشريك');
      
      let secretInfo = { role: p.role };
      if (p.role === 'الشريك') secretInfo.killerName = killer.name;
      if (p.role === 'شاهد العيان') {
        secretInfo.killerName = killer.name;
        secretInfo.accompliceName = accomplice.name;
      }

      io.to(p.id).emit('gameStarted', {
        me: p,
        secretInfo,
        allPlayers: room.players.map(pl => ({ id: pl.id, name: pl.name, weapons: pl.weapons, evidence: pl.evidence })),
        hints: room.hints
      });
    });
  });

  socket.on('killerSelect', ({ roomCode, weapon, evidence }) => {
    const room = rooms[roomCode];
    room.solution = { weapon, evidence };
    room.state = 'investigation';

    const killer = room.players.find(x => x.role === 'القاتل');
    const forensic = room.players.find(x => x.role === 'الطبيب الشرعي');
    const accomplice = room.players.find(x => x.role === 'الشريك');

    io.to(forensic.id).emit('solutionRevealed', { killer: killer.name, weapon, evidence });
    io.to(accomplice.id).emit('solutionRevealed', { killer: killer.name, weapon, evidence });
    io.to(roomCode).emit('phaseChanged', 'بدأت مرحلة التحقيق! الطبيب الشرعي يضع التلميحات الآن.');
  });

  socket.on('updateHint', ({ roomCode, hintIndex, option }) => {
    const room = rooms[roomCode];
    room.hints[hintIndex].selected = option;
    io.to(roomCode).emit('hintsUpdated', room.hints);
  });

  // اتهام المحققين -> ينتقل لاغتيال شاهد العيان إذا كان صحيحاً
  socket.on('makeAccusation', ({ roomCode, suspectId, weapon, evidence }) => {
    const room = rooms[roomCode];
    const killer = room.players.find(x => x.role === 'القاتل');
    
    if (suspectId === killer.id && weapon === room.solution.weapon && evidence === room.solution.evidence) {
      room.state = 'witness_assassination';
      io.to(roomCode).emit('phaseChanged', '⚠️ كُشف القاتل! الآن القاتل لديه فرصة أخيرة لاغتيال شاهد العيان!');
      
      // إرسال قائمة المرشحين للقاتل فقط ليختار شاهد العيان
      const candidates = room.players.filter(p => p.role !== 'القاتل' && p.role !== 'الشريك' && p.role !== 'الطبيب الشرعي');
      io.to(killer.id).emit('startWitnessGuess', candidates.map(c => ({ id: c.id, name: c.name })));
    } else {
      io.to(roomCode).emit('gameOver', { 
        winner: 'القاتل وشريكه!', 
        details: `اتهام خاطئ! الحل الصحيح كان: القاتل (${killer.name})، السلاح (${room.solution.weapon})، الدليل (${room.solution.evidence}).` 
      });
    }
  });

  // تخمين القاتل لشاهد العيان
  socket.on('guessWitness', ({ roomCode, targetId }) => {
    const room = rooms[roomCode];
    const witness = room.players.find(x => x.role === 'شاهد العيان');
    const target = room.players.find(x => x.id === targetId);

    if (targetId === witness.id) {
      io.to(roomCode).emit('gameOver', { 
        winner: 'القاتل وشريكه (بضربة قاضية)!', 
        details: `تم كشف القاتل، لكنه نجح في اغتيال شاهد العيان (${witness.name}) وسرق الفوز!` 
      });
    } else {
      io.to(roomCode).emit('gameOver', { 
        winner: 'فريق المحققين وشاهد العيان!', 
        details: `أخطأ القاتل واغتال (${target.name})! شاهد العيان الحقيقي هو (${witness.name}). انتصر المحققون!` 
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
