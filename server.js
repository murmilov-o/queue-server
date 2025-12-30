const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const WS_URL = "wss://trackensure.gitstel.net/sw-monitor/?EIO=3&transport=websocket";

// --- ХРАНИЛИЩЕ ИСТОРИИ ---
let history = {};
let eventLog = []; // Realtime log
const callJoinTimes = new Map();

// --- HELPERS ---
function getTodayKey() {
    return new Date().toLocaleDateString("en-US");
}

function getHourKey() {
    return new Date().getHours();
}

function ensureStatsExist(dateKey, hourKey) {
    if (!history[dateKey]) {
        history[dateKey] = { total: { ans: 0, wait: 0 }, hours: {} };
    }
    // ВАЖНО: Проверка на undefined, так как час 0 (полночь) это false в JS
    if (hourKey !== undefined && !history[dateKey].hours[hourKey]) {
        history[dateKey].hours[hourKey] = { ans: 0, wait: 0 };
    }
}

function cleanEventLog() {
    // Очищаем события старше 6 часов
    const threshold = Date.now() - (6 * 3600 * 1000);
    eventLog = eventLog.filter(e => e.time > threshold);
}

// --- WEBSOCKET ---
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

            const today = getTodayKey();
            
            // 1. JOIN
            if (type === 'queue_caller_join') {
                const num = d.connectedlinenum || d.calleridnum || d.caller_number;
                if (num) callJoinTimes.set(num, Date.now());
            }

            // 2. ANSWERED
            if (type === 'queue_caller_leave') {
                const qid = d.queue;
                const num = d.caller_number || d.calleridnum;
                
                if (qid) {
                    let duration = 0;
                    if (num && callJoinTimes.has(num)) {
                        duration = Math.round((Date.now() - callJoinTimes.get(num)) / 1000);
                        callJoinTimes.delete(num);
                    }

                    // Log Realtime
                    eventLog.push({ time: Date.now(), type: 'ans', queue: qid, duration: duration });
                    cleanEventLog();

                    // Log History
                    const hour = getHourKey();
                    ensureStatsExist(today, hour);
                    
                    history[today].total.ans++;
                    history[today].total.wait += duration;

                    history[today].hours[hour].ans++;
                    history[today].hours[hour].wait += duration;
                }
            }

            // 3. ABANDON
            if (type === 'queue_caller_abandon') {
                const num = d.caller_number || d.calleridnum;
                if (num && callJoinTimes.has(num)) callJoinTimes.delete(num);
            }

        } catch (e) { console.error("Parse Error:", e); }
    });

    ws.on('close', () => setTimeout(connect, 5000));
    ws.on('error', (e) => console.error("WS Error", e.message));
}

connect();

// --- API ---
app.get('/stats', (req, res) => {
    try {
        const now = Date.now();
        const periods = { h1: 3600000, h2: 7200000, h4: 14400000 };
        const todayKey = getTodayKey();
        ensureStatsExist(todayKey); // Создаем структуру на сегодня, если её нет

        const response = {
            daily: { queues: {} },
            globalDaily: history[todayKey].total,
            globalPeriods: { h1: { ans:0, wait:0 }, h2: { ans:0, wait:0 }, h4: { ans:0, wait:0 } },
            queuesPeriods: {}
        };

        const createStat = () => ({ ans: 0, wait: 0 });

        eventLog.forEach(ev => {
            if (!response.queuesPeriods[ev.queue]) {
                response.queuesPeriods[ev.queue] = { h1: createStat(), h2: createStat(), h4: createStat() };
            }
            const diff = now - ev.time;
            if (ev.type === 'ans') {
                ['h1', 'h2', 'h4'].forEach(pKey => {
                    if (diff <= periods[pKey]) {
                        response.globalPeriods[pKey].ans++;
                        response.globalPeriods[pKey].wait += ev.duration;
                        
                        if (response.queuesPeriods[ev.queue]) {
                            response.queuesPeriods[ev.queue][pKey].ans++;
                            response.queuesPeriods[ev.queue][pKey].wait += ev.duration;
                        }
                    }
                });
            }
        });
        res.json(response);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Internal Server Error" });
    }
});

app.get('/history', (req, res) => {
    res.json(history);
});

app.listen(PORT, () => console.log(`Server on ${PORT}`));
