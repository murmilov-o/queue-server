const WebSocket = require('ws');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());

const PORT = process.env.PORT || 3000;
const WS_URL = "wss://trackensure.gitstel.net/sw-monitor/?EIO=3&transport=websocket";

// --- ХРАНИЛИЩЕ ИСТОРИИ ---
// Структура:
// history = {
//   "12/30/2025": {
//      total: { ans: 0, wait: 0 },
//      hours: {
//         "14": { ans: 5, wait: 300 },
//         "15": { ans: 2, wait: 120 }
//      }
//   }
// }
let history = {};

// Журнал событий (для расчета периодов 1h/2h/4h в реальном времени)
let eventLog = [];

// Временная память (номер -> время входа)
const callJoinTimes = new Map();

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

function getTodayKey() {
    return new Date().toLocaleDateString("en-US"); // формат MM/DD/YYYY
}

function getHourKey() {
    return new Date().getHours(); // 0..23
}

// Инициализация дня и часа, если их нет
function ensureStatsExist(dateKey, hourKey) {
    if (!history[dateKey]) {
        history[dateKey] = { total: { ans: 0, wait: 0 }, hours: {} };
    }
    if (hourKey !== undefined && !history[dateKey].hours[hourKey]) {
        history[dateKey].hours[hourKey] = { ans: 0, wait: 0 };
    }
}

// Удаляем старые события из журнала (старше 5 часов), чтобы не забивать память
function cleanEventLog() {
    const threshold = Date.now() - (5 * 3600 * 1000);
    eventLog = eventLog.filter(e => e.time > threshold);
}

// --- WS CLIENT ---
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

            // 2. LEAVE (Answered)
            if (type === 'queue_caller_leave') {
                const qid = d.queue;
                const num = d.caller_number || d.calleridnum;
                
                if (qid) {
                    let duration = 0;
                    if (num && callJoinTimes.has(num)) {
                        duration = Math.round((Date.now() - callJoinTimes.get(num)) / 1000);
                        callJoinTimes.delete(num);
                    }

                    // Сохраняем в Realtime лог
                    eventLog.push({ time: Date.now(), type: 'ans', queue: qid, duration: duration });
                    cleanEventLog();

                    // Сохраняем в ИСТОРИЮ (по датам и часам)
                    const hour = getHourKey();
                    ensureStatsExist(today, hour);
                    
                    // Обновляем общий счетчик дня
                    history[today].total.ans++;
                    history[today].total.wait += duration;

                    // Обновляем счетчик часа
                    history[today].hours[hour].ans++;
                    history[today].hours[hour].wait += duration;
                }
            }

            // 3. ABANDON (Просто чистим время, в статистику Ans не пишем)
            if (type === 'queue_caller_abandon') {
                const num = d.caller_number || d.calleridnum;
                if (num && callJoinTimes.has(num)) {
                    callJoinTimes.delete(num);
                }
            }

        } catch (e) { /* ignore */ }
    });

    ws.on('close', () => setTimeout(connect, 5000));
    ws.on('error', (e) => console.error("WS Error", e.message));
}

connect();

// --- API ---

// 1. Основная статистика (Realtime + Periods)
app.get('/stats', (req, res) => {
    const now = Date.now();
    const periods = { h1: 3600000, h2: 7200000, h4: 14400000 };
    
    // Берем "сегодняшние" данные из истории для daily totals
    const todayKey = getTodayKey();
    ensureStatsExist(todayKey);
    
    // Структура ответа
    const response = {
        // Daily total берем из накопительной истории
        daily: { 
            queues: {} // Оставим пустым, так как мы теперь считаем глобально, или можно заполнить если нужно
        },
        // А вот это нам важно для Dashboard
        globalDaily: history[todayKey].total, 
        
        globalPeriods: { h1: { ans:0, wait:0 }, h2: { ans:0, wait:0 }, h4: { ans:0, wait:0 } },
        queuesPeriods: {} 
    };

    // Чтобы не ломать старый фронтенд, заполним daily.queues нулями (или можно реализовать логику по очередям в истории, если надо)
    // Пока упростим: Realtime считаем "на лету" из eventLog
    
    // Считаем периоды из eventLog
    const createStat = () => ({ ans: 0, wait: 0 });
    
    // Подготовка объектов очередей
    // (В реальном eventLog могут быть любые очереди, инициализируем по факту)
    
    eventLog.forEach(ev => {
        if (!response.queuesPeriods[ev.queue]) {
            response.queuesPeriods[ev.queue] = { h1: createStat(), h2: createStat(), h4: createStat() };
        }
        
        // Для таблицы очередей нам нужен Daily Total по каждой очереди. 
        // В текущей упрощенной history мы храним только глобально. 
        // Давайте подсчитаем Daily Total для очередей "на лету" из eventLog (только за последние 5 часов).
        // *Примечание: Это компромисс. Для полной точности надо хранить history[date].queues[qid].*
        // Но вы просили Total Answered Глобально.
        
        const diff = now - ev.time;
        if (ev.type === 'ans') {
            ['h1', 'h2', 'h4'].forEach(pKey => {
                if (diff <= periods[pKey]) {
                    // Global Period
                    response.globalPeriods[pKey].ans++;
                    response.globalPeriods[pKey].wait += ev.duration;
                    
                    // Queue Period
                    response.queuesPeriods[ev.queue][pKey].ans++;
                    response.queuesPeriods[ev.queue][pKey].wait += ev.duration;
                }
            });
        }
    });

    res.json(response);
});

// 2. НОВЫЙ ЭНДПОИНТ: Полная история
app.get('/history', (req, res) => {
    res.json(history);
});

app.listen(PORT, () => console.log(`Server on ${PORT}`));
