const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors()); // Разрешаем доступ с вашего GitHub Pages

const PORT = process.env.PORT || 3000;
const WS_URL = "wss://trackensure.gitstel.net/sw-monitor/?EIO=3&transport=websocket";

// Хранилище статистики
let dailyStats = {
    _date: new Date().toLocaleDateString("en-US"), // Формат даты
    queues: {}
};

// Временная память для расчета длительности (Кто когда позвонил)
const callJoinTimes = new Map();

// Функция сброса статистики в полночь
function checkDateAndReset() {
    const today = new Date().toLocaleDateString("en-US");
    if (dailyStats._date !== today) {
        console.log(`[${new Date().toISOString()}] New day detected! Resetting stats.`);
        dailyStats = { _date: today, queues: {} };
        callJoinTimes.clear();
    }
}

// Получить или создать объект статистики для очереди
function getQStats(qid) {
    if (!dailyStats.queues[qid]) {
        dailyStats.queues[qid] = { ans: 0, abd: 0, sl_hits: 0 };
    }
    return dailyStats.queues[qid];
}

let ws;
let pingInterval;

function connect() {
    console.log(`[${new Date().toISOString()}] Connecting to Telephony WS...`);
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        console.log('Connected!');
        // Пинг, чтобы соединение не разрывалось
        pingInterval = setInterval(() => {
            if(ws.readyState === WebSocket.OPEN) ws.send('2');
        }, 25000);
    });

    ws.on('message', (data) => {
        const strData = data.toString();
        // Игнорируем системные сообщения socket.io
        if (!strData.startsWith('42')) return;

        try {
            const payload = JSON.parse(strData.slice(2));
            const type = payload[0];
            const d = payload[1];

            checkDateAndReset();

            // 1. JOIN (Вход в очередь)
            if (type === 'queue_caller_join') {
                // Пытаемся найти номер звонящего
                const number = d.connectedlinenum || d.calleridnum || d.caller_number;
                if (number) {
                    callJoinTimes.set(number, Date.now());
                }
            }

            // 2. LEAVE (Ответили)
            if (type === 'queue_caller_leave') {
                const qid = d.queue;
                const number = d.caller_number || d.calleridnum; // Иногда номер здесь
                
                if (qid) {
                    const stats = getQStats(qid);
                    stats.ans++;

                    // Считаем SL (если ответили быстрее 30 сек)
                    if (number && callJoinTimes.has(number)) {
                        const duration = (Date.now() - callJoinTimes.get(number)) / 1000;
                        if (duration <= 30) stats.sl_hits++;
                        callJoinTimes.delete(number);
                    } else {
                        // Если номера нет, просто засчитываем ответ, но без SL (безопаснее)
                    }
                }
            }

            // 3. ABANDON (Сбросили)
            if (type === 'queue_caller_abandon') {
                const qid = d.queue;
                if (qid) {
                    const stats = getQStats(qid);
                    stats.abd++;
                }
            }

        } catch (e) {
            console.error("Parse Error:", e.message);
        }
    });

    ws.on('close', () => {
        console.log('WS Closed. Reconnecting in 5s...');
        clearInterval(pingInterval);
        setTimeout(connect, 5000);
    });

    ws.on('error', (err) => {
        console.error('WS Error:', err.message);
        ws.close();
    });
}

connect();

// API Endpoint для вашего сайта
app.get('/stats', (req, res) => {
    res.json(dailyStats);
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`Stats Server running on port ${PORT}`);
});
