const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const WS_URL = "wss://trackensure.gitstel.net/sw-monitor/?EIO=3&transport=websocket";

// --- ДАННЫЕ ---
let dailyStats = {
    _date: new Date().toLocaleDateString("en-US"),
    queues: {}
};

// Журнал для графиков
let eventLog = [];

// Временная память для SL (номер -> время входа)
const callJoinTimes = new Map();

// ГЛАВНОЕ НОВОВВЕДЕНИЕ: Список активных звонков
// Структура: { "Q700": [ { number: "...", name: "...", time: 12345 } ], ... }
let activeCallers = {};

function checkDateAndReset() {
    const today = new Date().toLocaleDateString("en-US");
    if (dailyStats._date !== today) {
        console.log("New day! Stats reset.");
        dailyStats = { _date: today, queues: {} };
        eventLog = [];
        callJoinTimes.clear();
        // activeCallers НЕ сбрасываем, так как люди могут висеть через полночь
    }
}

function getQStats(qid) {
    if (!dailyStats.queues[qid]) {
        dailyStats.queues[qid] = { ans: 0, abd: 0, sl_hits: 0 };
    }
    return dailyStats.queues[qid];
}

// Хелпер: Удалить активного звонящего из списка
function removeActiveCaller(qid, number) {
    if (activeCallers[qid]) {
        activeCallers[qid] = activeCallers[qid].filter(c => c.number !== number);
    }
}

// --- WS ---
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
                const num = d.connectedlinenum || d.calleridnum || d.caller_number || "";
                const name = d.connectedlinename || d.calleridname || d.caller_name || "";
                const qid = d.queue;

                if (num) {
                    callJoinTimes.set(num, Date.now());
                    
                    // Добавляем в активный список
                    if (!activeCallers[qid]) activeCallers[qid] = [];
                    // Сначала удаляем дубликат, если вдруг есть
                    removeActiveCaller(qid, num);
                    activeCallers[qid].push({ number: num, name: name, joinTime: Date.now() });
                }
            }

            // 2. LEAVE (Answered)
            if (type === 'queue_caller_leave') {
                const qid = d.queue;
                const num = d.caller_number || d.calleridnum;
                
                if (qid) {
                    // Убираем из активных
                    if (num) removeActiveCaller(qid, num);

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
                    eventLog.push({ time: Date.now(), type: 'ans', sl: isSlHit, queue: qid });
                }
            }

            // 3. ABANDON
            if (type === 'queue_caller_abandon') {
                const qid = d.queue;
                const num = d.caller_number || d.calleridnum; // Обычно здесь есть номер

                if (qid) {
                    // Убираем из активных (ищем по номеру, если он пришел, или удаляем самого старого, если нет)
                    if (num) {
                        removeActiveCaller(qid, num);
                    } else if (activeCallers[qid] && activeCallers[qid].length > 0) {
                        // Если номера нет, удаляем первого (FIFO) - грубый метод, но лучше чем ничего
                        activeCallers[qid].shift();
                    }

                    const stats = getQStats(qid);
                    stats.abd++;
                    eventLog.push({ time: Date.now(), type: 'abd', sl: false, queue: qid });
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
    const periods = { h1: 3600000, h2: 7200000, h4: 14400000 };
    
    const response = {
        daily: dailyStats,
        globalPeriods: { h1: {}, h2: {}, h4: {} },
        queuesPeriods: {},
        activeCallers: activeCallers // <--- ОТДАЕМ СПИСОК ЗВОНЯЩИХ
    };

    const createStat = () => ({ ans: 0, abd: 0, slHits: 0, sl: 0 });

    Object.keys(dailyStats.queues).forEach(qid => {
        response.queuesPeriods[qid] = { h1: createStat(), h2: createStat(), h4: createStat() };
    });
    response.globalPeriods = { h1: createStat(), h2: createStat(), h4: createStat() };

    eventLog.forEach(ev => {
        const diff = now - ev.time;
        ['h1', 'h2', 'h4'].forEach(pKey => {
            if (diff <= periods[pKey]) {
                const gStat = response.globalPeriods[pKey];
                if (ev.type === 'ans') { gStat.ans++; if (ev.sl) gStat.slHits++; } else { gStat.abd++; }

                if (response.queuesPeriods[ev.queue]) {
                    const qStat = response.queuesPeriods[ev.queue][pKey];
                    if (ev.type === 'ans') { qStat.ans++; if (ev.sl) qStat.slHits++; } else { qStat.abd++; }
                }
            }
        });
    });

    const calcSL = (obj) => {
        obj.sl = obj.ans > 0 ? Math.round((obj.slHits / obj.ans) * 100) : 0;
        delete obj.slHits;
    };

    ['h1', 'h2', 'h4'].forEach(p => {
        calcSL(response.globalPeriods[p]);
        Object.values(response.queuesPeriods).forEach(qObj => calcSL(qObj[p]));
    });

    res.json(response);
});

app.listen(PORT, () => console.log(`Server on ${PORT}`));
