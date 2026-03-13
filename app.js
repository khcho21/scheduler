document.addEventListener('DOMContentLoaded', () => {
    // --- PWA Service Worker Registration ---
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW 등록 실패:', err));
    }

    // --- State Management ---
    const STORAGE_KEY = 'giga_scheduler_v3_data';
    let currentDate = new Date();
    let selectedDateStr = null;
    let data = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};

    // --- DOM Elements ---
    const calendarBody = document.getElementById('calendar-body');
    const calendarTitle = document.getElementById('calendar-title');
    const prevMonthBtn = document.getElementById('prev-month');
    const nextMonthBtn = document.getElementById('next-month');
    
    const editModal = document.getElementById('edit-modal');
    const modalDateTitle = document.getElementById('modal-date');
    const inputType = document.getElementById('input-type');
    const inputClockIn = document.getElementById('input-clock-in');
    const inputClockOut = document.getElementById('input-clock-out');
    const inputNote = document.getElementById('input-note');
    const modalSaveBtn = document.getElementById('modal-save');
    const modalCancelBtn = document.getElementById('modal-cancel');
    const modalDeleteBtn = document.getElementById('modal-delete');

    const baseHoursEl = document.getElementById('base-hours');
    const totalHoursEl = document.getElementById('total-hours');
    const diffHoursEl = document.getElementById('diff-hours');

    // --- Helper Functions ---

    function getLocalDateString(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function normalizeTime(val) {
        if (!val) return null;
        val = val.replace(/[^0-9]/g, ''); 
        if (val.length === 1) val = '0' + val + '00'; 
        if (val.length === 2) val = val + '00'; 
        if (val.length === 3) val = '0' + val; 
        if (val.length === 4) {
            const h = parseInt(val.substring(0, 2));
            const m = parseInt(val.substring(2, 4));
            if (h >= 0 && h < 24 && m >= 0 && m < 60) {
                return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00`;
            }
        }
        return "INVALID";
    }

    function formatTimeForUI(isoTime) {
        if (!isoTime || isoTime === "INVALID") return '';
        return isoTime.substring(0, 5);
    }

    // --- Calculation Engine ---

    function calculateAcknowledgedTime(dateStr, entry) {
        if (!entry) return 0;
        const type = entry.type || '';
        
        if (['출장', '휴가', '공가', '병가'].includes(type)) return 8 * 3600;
        if (type === '휴일') return 0; // 휴일은 목표 시간에서 차감되므로 인정 시간은 0
        if (type === '봉사' || type === '봉사(4.5h)') return 4.5 * 3600;
        if (type === '휴가(4h)' || type === '반차') return 4 * 3600;
        if (type === '최소근로') return 0;
        
        if (!entry.clockIn || !entry.clockOut || entry.clockIn === "INVALID" || entry.clockOut === "INVALID") return 0;

        let start = entry.clockIn;
        let end = entry.clockOut;

        if (start < "06:00:00") start = "06:00:00";
        if (end > "22:00:00") end = "22:00:00";
        if (start >= end) return 0;

        const sDate = new Date(`2000-01-01T${start}`);
        const eDate = new Date(`2000-01-01T${end}`);
        let diffSec = (eDate - sDate) / 1000;

        const workHours = diffSec / 3600;
        const deductionCount = Math.floor(workHours / 4.5);
        const totalDeduction = deductionCount * 0.5 * 3600;

        return Math.max(0, diffSec - totalDeduction);
    }

    // --- Core Logic ---

    function saveData() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        render();
    }

    function calculateStats() {
        let totalSeconds = 0;
        let targetWeekdays = 0;
        let holidayInWeekdays = 0;
        
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth();

        // 1. Calculate Target Hours (Based on weekdays)
        const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
        for (let d = 1; d <= lastDayOfMonth; d++) {
            const date = new Date(year, month, d);
            const dayOfWeek = date.getDay();
            const dateStr = getLocalDateString(date);
            
            if (dayOfWeek >= 1 && dayOfWeek <= 5) { // Mon-Fri
                targetWeekdays++;
                // Check if this weekday is marked as 'Holiday' or 'Exclude'
                if (data[dateStr] && (data[dateStr].type === '휴일' || data[dateStr].type === '제외')) {
                    holidayInWeekdays++;
                }
            }
        }

        const baseH = (targetWeekdays - holidayInWeekdays) * 8;
        baseHoursEl.innerText = `${baseH}h`;

        // 2. Calculate Actual Accumulated Time
        Object.keys(data).forEach(dateStr => {
            const [y, m, d] = dateStr.split('-').map(Number);
            if (y === year && (m - 1) === month) {
                totalSeconds += calculateAcknowledgedTime(dateStr, data[dateStr]);
            }
        });

        const totalH = Math.floor(totalSeconds / 3600);
        const totalM = Math.floor((totalSeconds % 3600) / 60);
        totalHoursEl.innerText = `${totalH}h ${totalM}m`;

        // 3. Difference
        const diffS = totalSeconds - (baseH * 3600);
        const diffH = Math.floor(Math.abs(diffS) / 3600);
        const diffM = Math.floor((Math.abs(diffS) % 3600) / 60);
        
        diffHoursEl.innerText = (diffS >= 0 ? '+' : '-') + `${diffH}h ${diffM}m`;
        diffHoursEl.style.color = diffS >= 0 ? '#10b981' : '#ef4444';
    }

    function render() {
        calendarBody.innerHTML = '';
        const year = currentDate.getFullYear();
        const month = currentDate.getMonth();

        calendarTitle.innerText = `${year}년 ${month + 1}월`;
        const statMonthText = `${year}년 ${month + 1}월 현황`;
        if (document.getElementById('stat-month')) {
            document.getElementById('stat-month').innerText = statMonthText;
        }

        const firstDay = new Date(year, month, 1).getDay();
        
        // 42 cells fixed
        for (let i = 0; i < 42; i++) {
            const cellDate = new Date(year, month, i - firstDay + 1);
            const isOtherMonth = cellDate.getMonth() !== month;
            calendarBody.appendChild(createDayCell(cellDate, isOtherMonth));
        }

        calculateStats();
    }

    function createDayCell(date, isOtherMonth) {
        const dateStr = getLocalDateString(date);
        const isToday = dateStr === getLocalDateString(new Date());
        
        const dayDiv = document.createElement('div');
        dayDiv.className = `day-cell ${isOtherMonth ? 'other-month' : ''} ${isToday ? 'today' : ''}`;
        
        dayDiv.innerHTML = `<div class="day-num">${date.getDate()}</div>`;

        if (data[dateStr]) {
            const entry = data[dateStr];
            const ackTime = calculateAcknowledgedTime(dateStr, entry);
            
            if (entry.type) {
                dayDiv.innerHTML += `<div class="entry-badge badge-plan">🏷️ ${entry.type}</div>`;
            }
            if (entry.clockIn && entry.clockIn !== "INVALID") {
                dayDiv.innerHTML += `<div class="entry-badge badge-work">🕒 ${formatTimeForUI(entry.clockIn)}~${formatTimeForUI(entry.clockOut)}</div>`;
            } else if (entry.note) {
                 dayDiv.innerHTML += `<div class="entry-badge badge-plan">📝 ${entry.note.substring(0, 10)}...</div>`;
            }
            if (ackTime > 0) {
                const h = Math.floor(ackTime / 3600);
                const m = Math.floor((ackTime % 3600) / 60);
                dayDiv.innerHTML += `<div style="font-size:0.6rem; color:#94a3b8; margin-top:auto">인정: ${h}h ${m}m</div>`;
            }
        }

        dayDiv.onclick = () => openModal(dateStr);
        return dayDiv;
    }

    function openModal(dateStr) {
        selectedDateStr = dateStr;
        modalDateTitle.innerText = dateStr;
        const entry = data[dateStr] || {};
        inputType.value = entry.type || '';
        inputClockIn.value = formatTimeForUI(entry.clockIn);
        inputClockOut.value = formatTimeForUI(entry.clockOut);
        inputNote.value = entry.note || '';
        editModal.style.display = 'flex';
    }

    // --- Action Handlers ---

    modalCancelBtn.onclick = () => { editModal.style.display = 'none'; };
    
    modalDeleteBtn.onclick = (e) => {
        e.stopPropagation();
        if (!selectedDateStr) return;
        if (confirm(`${selectedDateStr}의 기록을 모두 삭제하시겠습니까?`)) {
            delete data[selectedDateStr];
            saveData();
            editModal.style.display = 'none';
        }
    };

    modalSaveBtn.onclick = () => {
        const ci = normalizeTime(inputClockIn.value);
        const co = normalizeTime(inputClockOut.value);

        if ((inputClockIn.value && ci === "INVALID") || (inputClockOut.value && co === "INVALID")) {
            alert("시간 형식이 올바르지 않습니다. (예: 09:00 또는 0900)");
            return;
        }

        if (!data[selectedDateStr]) data[selectedDateStr] = {};
        data[selectedDateStr].type = inputType.value;
        data[selectedDateStr].clockIn = ci;
        data[selectedDateStr].clockOut = co;
        data[selectedDateStr].note = inputNote.value;
        
        if (!inputType.value && !ci && !co && !inputNote.value) {
            delete data[selectedDateStr];
        }

        saveData();
        editModal.style.display = 'none';
    };

    prevMonthBtn.onclick = () => { currentDate.setMonth(currentDate.getMonth() - 1); render(); };
    nextMonthBtn.onclick = () => { currentDate.setMonth(currentDate.getMonth() + 1); render(); };

    render();
});
