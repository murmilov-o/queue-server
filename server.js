const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const WS_URL = "wss://trackensure.gitstel.net/sw-monitor/?EIO=3&transport=websocket";

// --- ХРАНИЛИЩЕ ---
// История по дням: { "12/30/2025": { hours: { "10": { ans: 5, wait: 300 } }, total: { ans: 5, wait: 300 } } }
let history = {}; 

// Лог текущих событий для расчета 1h/2h/4h
let eventLog = []; 

// Память звонков: номер -> время начала (timestamp)
const callJoinTimes = new Map();

// --- HELPERS ---
function getTodayKey() {
    return new Date().toLocaleDateString("en-US");
}

function getHourKey() {
    return new Date().getHours();
}

// Безопасное создание структуры истории (чтобы сервер не падал)
function ensureStatsExist(dateKey, hourKey) {
    try {
        if (!history[dateKey]) {
            history[dateKey] = { total: { ans: 0, wait: 0 }, hours: {} };
        }
        if (hourKey !== undefined) {
            if (!history[dateKey].hours) history[dateKey].hours = {};
            if (!history[dateKey].hours[hourKey]) {
                history[dateKey].hours[hourKey] = { ans: 0, wait: 0 };
            }
        }
    } catch (e) {
        console.error("Init Stats Error:", e);
    }
}

// Очистка старых событий из памяти (старше 6 часов)
function cleanEventLog() {
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
        console.log("Connected to Remote WS!");
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

            // 1. JOIN (Начало звонка)
            if (type === 'queue_caller_join') {
                const num = d.connectedlinenum || d.calleridnum || d.caller_number;
                if (num) callJoinTimes.set(num, Date.now());
            }

            // 2. ANSWERED (Отвеченный)
            if (type === 'queue_caller_leave') {
                const qid = d.queue;
                const num = d.caller_number || d.calleridnum;
                
                if (qid) {
                    // Считаем сколько висел на линии
                    let duration = 0;
                    if (num && callJoinTimes.has(num)) {
                        duration = Math.round((Date.now() - callJoinTimes.get(num)) / 1000);
                        callJoinTimes.delete(num);
                    }

                    // 1. Пишем в оперативный лог (для 1h, 2h, 4h)
                    eventLog.push({ time: Date.now(), type: 'ans', queue: qid, duration: duration });
                    cleanEventLog();

                    // 2. Пишем в Историю
                    const today = getTodayKey();
                    const hour = getHourKey();
                    ensureStatsExist(today, hour);
                    
                    // Обновляем счетчики (с проверкой на существование)
                    if (history[today] && history[today].total) {
                        history[today].total.ans++;
                        history[today].total.wait += duration;
                    }
                    if (history[today] && history[today].hours && history[today].hours[hour]) {
                        history[today].hours[hour].ans++;
                        history[today].hours[hour].wait += duration;
                    }
                }
            }

            // 3. ABANDON (Сброшенный - просто удаляем из памяти времени)
            if (type === 'queue_caller_abandon') {
                const num = d.caller_number || d.calleridnum;
                if (num && callJoinTimes.has(num)) callJoinTimes.delete(num);
            }

        } catch (e) { 
            // Игнорируем ошибки парсинга
        }
    });

    ws.on('close', () => setTimeout(connect, 5000));
    ws.on('error', (e) => console.error("WS Error", e.message));
}

connect();

// --- API ---

// Статистика (Текущая + Периоды)
app.get('/stats', (req, res) => {
    try {
        const now = Date.now();
        const periods = { h1: 3600000, h2: 7200000, h4: 14400000 };
        const todayKey = getTodayKey();
        
        // Гарантируем, что объект есть, чтобы фронт не получил null
        ensureStatsExist(todayKey); 

        const response = {
            // Общая статистика за сегодня (из истории)
            globalDaily: history[todayKey] ? history[todayKey].total : { ans: 0, wait: 0 },
            // Периоды (считаем сейчас)
            globalPeriods: { h1: { ans:0, wait:0 }, h2: { ans:0, wait:0 }, h4: { ans:0, wait:0 } },
            queuesPeriods: {} // По очередям
        };

        const createStat = () => ({ ans: 0, wait: 0 });

        // Пробегаем по логу событий
        eventLog.forEach(ev => {
            if (!ev.queue) return;

            // Инициализация объекта очереди, если нет
            if (!response.queuesPeriods[ev.queue]) {
                response.queuesPeriods[ev.queue] = { h1: createStat(), h2: createStat(), h4: createStat() };
            }
            
            const diff = now - ev.time;
            
            // Если это отвеченный звонок
            if (ev.type === 'ans') {
                ['h1', 'h2', 'h4'].forEach(pKey => {
                    if (diff <= periods[pKey]) {
                        // Глобально
                        response.globalPeriods[pKey].ans++;
                        response.globalPeriods[pKey].wait += (ev.duration || 0);
                        
                        // По очереди
                        if (response.queuesPeriods[ev.queue]) {
                            response.queuesPeriods[ev.queue][pKey].ans++;
                            response.queuesPeriods[ev.queue][pKey].wait += (ev.duration || 0);
                        }
                    }
                });
            }
        });

        res.json(response);
    } catch (err) {
        console.error("API Error:", err);
        res.status(500).json({ error: "Server Error" });
    }
});

// История (Для вкладки "Статистика")
app.get('/history', (req, res) => {
    res.json(history);
});

app.listen(PORT, () => console.log(`Server on ${PORT}`));
