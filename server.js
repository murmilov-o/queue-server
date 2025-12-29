const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const WS_URL = "wss://trackensure.gitstel.net/sw-monitor/?EIO=3&transport=websocket";

// --- ХРАНИЛИЩЕ ДАННЫХ ---
let dailyStats = {
    _date: new Date().toLocaleDateString("en-US"),
    queues: {}
};

// Журнал событий для расчета периодов (1h, 2h, 4h)
// Храним объекты: { time: 1678888..., type: 'ans'|'abd', sl: true|false }
let eventLog = [];

// Временная память (кто сейчас висит на линии)
const callJoinTimes = new Map();

function checkDateAndReset() {
    const today = new Date().toLocaleDateString("en-US");
    if (dailyStats._date !== today) {
        console.log("New day! Stats reset.");
        dailyStats = { _date: today, queues: {} };
        eventLog = []; // Очищаем журнал за прошлый день
        callJoinTimes.clear();
    }
}

function getQStats(qid) {
    if (!dailyStats.queues[qid]) {
        dailyStats.queues[qid] = { ans: 0, abd: 0, sl_hits: 0 };
    }
    return dailyStats.queues[qid];
}

// --- WS LOGIC ---
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

            // 1. JOIN
            if (type === 'queue_caller_join') {
                const num = d.connectedlinenum || d.calleridnum || d.caller_number;
                if (num) callJoinTimes.set(num, Date.now());
            }

            // 2. LEAVE (Answered)
            if (type === 'queue_caller_leave') {
                const qid = d.queue;
                const num = d.caller_number || d.calleridnum;
                
                if (qid) {
                    const stats = getQStats(qid);
                    stats.ans++;
                    
                    let isSlHit = false;
                    if (num && callJoinTimes.has(num)) {
                        const duration = (Date.now() - callJoinTimes.get(num)) / 1000;
                        if (duration <= 30) {
                            stats.sl_hits++;
                            isSlHit = true;
                        }
                        callJoinTimes.delete(num);
                    }

                    // Добавляем в журнал для графиков/ховера
                    eventLog.push({
                        time: Date.now(),
                        type: 'ans',
                        sl: isSlHit
                    });
                }
            }

            // 3. ABANDON
            if (type === 'queue_caller_abandon') {
                const qid = d.queue;
                if (qid) {
                    const stats = getQStats(qid);
                    stats.abd++;
                    
                    // Добавляем в журнал
                    eventLog.push({
                        time: Date.now(),
                        type: 'abd',
                        sl: false
                    });
                }
            }

        } catch (e) { /* ignore */ }
    });

    ws.on('close', () => setTimeout(connect, 5000));
    ws.on('error', (e) => console.error("WS Error", e.message));
}

connect();

// --- API ---
app.get('/stats', (req, res) => {
    const now = Date.now();
    
    // Функция подсчета за последние N миллисекунд
    const calcPeriod = (ms) => {
        const threshold = now - ms;
        // Берем события только за этот период
        const events = eventLog.filter(e => e.time >= threshold);
        
        const ans = events.filter(e => e.type === 'ans').length;
        const abd = events.filter(e => e.type === 'abd').length;
        const slHits = events.filter(e => e.type === 'ans' && e.sl).length;
        
        // SL считаем только от отвеченных в этот период
        const sl = ans > 0 ? Math.round((slHits / ans) * 100) : 0;
        
        return { ans, abd, sl };
    };

    res.json({
        daily: dailyStats, // Общая за день (для таблицы)
        periods: {         // Для тултипов
            h1: calcPeriod(3600 * 1000),      // 1 час
            h2: calcPeriod(7200 * 1000),      // 2 часа
            h4: calcPeriod(14400 * 1000)      // 4 часа
        }
    });
});

app.listen(PORT, () => console.log(`Server on ${PORT}`));
