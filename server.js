const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const WS_URL = "wss://trackensure.gitstel.net/sw-monitor/?EIO=3&transport=websocket";

// Статистика за день
let dailyStats = {
    _date: new Date().toLocaleDateString("en-US"),
    queues: {}
};

// Журнал подій { time, type, queue, duration }
let eventLog = [];

// Тимчасова пам'ять (номер -> час входу)
const callJoinTimes = new Map();

function checkDateAndReset() {
    const today = new Date().toLocaleDateString("en-US");
    if (dailyStats._date !== today) {
        console.log("New day! Stats reset.");
        dailyStats = { _date: today, queues: {} };
        eventLog = [];
        callJoinTimes.clear();
    }
}

// Очищення старих логів (старше 5 годин)
function cleanLogs() {
    const threshold = Date.now() - (5 * 3600 * 1000);
    if (eventLog.length > 5000) {
        eventLog = eventLog.filter(e => e.time > threshold);
    }
}

function getQStats(qid) {
    if (!dailyStats.queues[qid]) {
        // ans = прийняті, abd = скинуті (для історії, хоча на фронті не показуємо)
        dailyStats.queues[qid] = { ans: 0, abd: 0 };
    }
    return dailyStats.queues[qid];
}

let ws;
let pingInterval;

function connect() {
    console.log("Connecting to WS...");
    ws = new WebSocket(WS_URL);

    ws.on('open', () => {
        console.log("Connected!");
        clearInterval(pingInterval);
        pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.send('2');
        }, 25000);
    });

    ws.on('message', (data) => {
        const str = data.toString();
        if (!str.startsWith('42')) return;

        try {
            const payload = JSON.parse(str.slice(2));
            const type = payload[0];
            const d = payload[1];

            checkDateAndReset();

            // 1. JOIN (Запам'ятовуємо час входу)
            if (type === 'queue_caller_join') {
                const num = d.connectedlinenum || d.calleridnum || d.caller_number;
                if (num) callJoinTimes.set(num, Date.now());
            }

            // 2. LEAVE (Answered - Прийнятий)
            if (type === 'queue_caller_leave') {
                const qid = d.queue;
                const num = d.caller_number || d.calleridnum;
                
                if (qid) {
                    const stats = getQStats(qid);
                    stats.ans++;
                    
                    // Рахуємо тривалість очікування/розмови
                    let duration = 0;
                    if (num && callJoinTimes.has(num)) {
                        duration = Math.round((Date.now() - callJoinTimes.get(num)) / 1000);
                        callJoinTimes.delete(num);
                    }
                    // Зберігаємо подію з тривалістю
                    eventLog.push({ time: Date.now(), type: 'ans', queue: qid, duration: duration });
                    cleanLogs();
                }
            }

            // 3. ABANDON (Скинутий)
            if (type === 'queue_caller_abandon') {
                const qid = d.queue;
                const num = d.caller_number || d.calleridnum;
                if (qid) {
                    const stats = getQStats(qid);
                    stats.abd++;
                    if (num && callJoinTimes.has(num)) callJoinTimes.delete(num);
                    // Можемо писати в лог, але для статистики часу це не використовується
                }
            }

        } catch (e) { /* ignore */ }
    });

    ws.on('close', () => setTimeout(connect, 5000));
    ws.on('error', (e) => console.error("WS Error", e.message));
}

connect();

// API
app.get('/stats', (req, res) => {
    const now = Date.now();
    const periods = { h1: 3600000, h2: 7200000, h4: 14400000 };
    
    const response = {
        daily: dailyStats,
        globalPeriods: { h1: {}, h2: {}, h4: {} },
        queuesPeriods: {}
    };

    // Структура статистики: ans (кількість), wait (сума секунд)
    const createStat = () => ({ ans: 0, wait: 0 });

    // Ініціалізація глобальних
    response.globalPeriods = { h1: createStat(), h2: createStat(), h4: createStat() };

    eventLog.forEach(ev => {
        // Ініціалізація черг по факту
        if (!response.queuesPeriods[ev.queue]) {
            response.queuesPeriods[ev.queue] = { h1: createStat(), h2: createStat(), h4: createStat() };
        }

        const diff = now - ev.time;
        // Рахуємо тільки прийняті (ans)
        if (ev.type === 'ans') { 
            ['h1', 'h2', 'h4'].forEach(pKey => {
                if (diff <= periods[pKey]) {
                    // Global
                    response.globalPeriods[pKey].ans++;
                    response.globalPeriods[pKey].wait += (ev.duration || 0);

                    // Queue
                    response.queuesPeriods[ev.queue][pKey].ans++;
                    response.queuesPeriods[ev.queue][pKey].wait += (ev.duration || 0);
                }
            });
        }
    });

    res.json(response);
});

app.listen(PORT, () => console.log(`Server on ${PORT}`));
