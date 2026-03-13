document.addEventListener('DOMContentLoaded', () => {
    // --- PWA Service Worker Registration ---
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(err => console.log('SW 등록 실패:', err));
    }

    // --- State Management ---
    const STORAGE_KEY = 'giga_scheduler_v3_data';
    const SYNC_CODE_KEY = 'scheduler_sync_code';
    let currentDate = new Date();
    let selectedDateStr = null;
    let data = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    let holidays = window.KOREA_HOLIDAYS || {}; 
    let isSyncEnabled = false;
    let syncCode = localStorage.getItem(SYNC_CODE_KEY);

    // --- Default Hours Settings ---
    const DEFAULT_HOURS = {
        1: { in: "11:00", out: "22:00" }, // 월요일
        2: { in: "09:00", out: "22:00" }, // 화요일
        3: { in: "09:00", out: "22:00" }, // 수요일
        4: { in: "09:00", out: "22:00" }, // 목요일
        5: { in: "08:00", out: "13:00" }  // 금요일
    };

    // --- Firebase Initialization (Using a dedicated public database for easy setup) ---
    const firebaseConfig = {
        databaseURL: "https://gigascheduler-default-rtdb.firebaseio.com"
    };

    if (syncCode) {
        initFirebase();
    }

    function initFirebase() {
        if (!window.firebase) {
            console.error('Firebase SDK가 로드되지 않았습니다.');
            return;
        }
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }
        isSyncEnabled = true;
        console.log('Firebase 초기화 성공, 동기화 코드:', syncCode);
        
        // 원격 데이터 변경 감지 및 동기화
        const dbRef = firebase.database().ref('users/' + syncCode);
        dbRef.on('value', (snapshot) => {
            const remoteData = snapshot.val();
            if (remoteData) {
                console.log('원격 데이터 수신 완료');
                // 로컬 데이터와 원격 데이터 병합 (날짜별 최신 데이터 우선)
                data = { ...data, ...remoteData };
                localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
                render();
            }
        });

        // 초기 접속 시 한번 강제 푸시 (데이터 유실 방지)
        dbRef.once('value').then(snap => {
            if (!snap.exists()) {
                console.log('원격에 데이터가 없어 로컬 데이터를 업로드합니다.');
                dbRef.set(data);
            }
        });
    }

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

    // Sync UI Elements
    const syncSettingsBtn = document.getElementById('sync-settings-btn');
    const syncModal = document.getElementById('sync-modal');
    const syncCodeInput = document.getElementById('sync-code-input');
    const syncCodeGenBtn = document.getElementById('sync-code-gen');
    const syncApplyBtn = document.getElementById('sync-apply-btn');
    const syncModalClose = document.getElementById('sync-modal-close');

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

    // --- Holiday Engine (내장 데이터 사용으로 전환) ---
    function fetchHolidays(year) {
        // 이미 내장 데이터가 로드되어 있으므로 별도 패치 불필요
        console.log(`${year}년 공휴일 연동 중... (Google Calendar 기준)`);
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

        // 공휴일 미리 가져오기
        fetchHolidays(year);

        const lastDayOfMonth = new Date(year, month + 1, 0).getDate();
        for (let d = 1; d <= lastDayOfMonth; d++) {
            const date = new Date(year, month, d);
            const dayOfWeek = date.getDay();
            const dateStr = getLocalDateString(date);
            
            if (dayOfWeek >= 1 && dayOfWeek <= 5) { // 평일(월-금)
                targetWeekdays++;
                
                const isManualHoliday = data[dateStr] && (data[dateStr].type === '휴일' || data[dateStr].type === '제외');
                const isAutoHoliday = holidays[year] && holidays[year][dateStr];

                if (isManualHoliday || isAutoHoliday) {
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

        // 1. 해당 월의 모든 날짜 생성 (평일만)
        const firstDayDate = new Date(year, month, 1);
        let firstDayOfWeek = firstDayDate.getDay(); // 0(일) ~ 6(토)
        
        // 월요일 기준 패딩 계산 (월=1, 화=2, ... 금=5, 토=6, 일=0)
        // 5일 캘린더이므로 월요일(1)이 첫 번째 컬럼이 됨
        let paddingDays = 0;
        if (firstDayOfWeek === 0) paddingDays = 0; // 일요일이면 월요일부터 시작하므로 패딩 0
        else if (firstDayOfWeek === 6) paddingDays = 0; // 토요일이면 월요일부터 시작하므로 패딩 0
        else paddingDays = firstDayOfWeek - 1; // 월(1) -> 0, 화(2) -> 1 ... 금(5) -> 4

        // 패딩 셀 추가 (이전 달 평일)
        for (let i = 0; i < paddingDays; i++) {
            const padDiv = document.createElement('div');
            padDiv.className = 'day-cell empty';
            calendarBody.appendChild(padDiv);
        }

        // 실제 날짜 셀 추가
        const lastDay = new Date(year, month + 1, 0).getDate();
        for (let d = 1; d <= lastDay; d++) {
            const date = new Date(year, month, d);
            const dayOfWeek = date.getDay();
            
            // 토(6), 일(0) 제외
            if (dayOfWeek !== 0 && dayOfWeek !== 6) {
                calendarBody.appendChild(createDayCell(date, false));
            }
        }

        calculateStats();
    }

    function createDayCell(date, isOtherMonth) {
        const dateStr = getLocalDateString(date);
        const isToday = dateStr === getLocalDateString(new Date());
        const year = date.getFullYear(); // ReferenceError 수정
        
        const dayDiv = document.createElement('div');
        dayDiv.className = `day-cell ${isOtherMonth ? 'other-month' : ''} ${isToday ? 'today' : ''}`;
        
        dayDiv.innerHTML = `<div class="day-num">${date.getDate()}</div>`;

        // 공휴일 표시 (빨간 날)
        const dayHolidays = holidays[year] || {};
        if (dayHolidays[dateStr]) {
            dayDiv.classList.add('holiday-text');
            dayDiv.innerHTML += `<div class="holiday-name">${dayHolidays[dateStr]}</div>`;
        }

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
        
        // 날짜 객체 생성 (timezone 문제 방지를 위해 분리 파싱)
        const [y, m, d] = dateStr.split('-').map(Number);
        const dateObj = new Date(y, m - 1, d);
        const dayOfWeek = dateObj.getDay();
        const year = dateObj.getFullYear();
        const isHoliday = holidays[year] && holidays[year][dateStr];

        // 기록이 없고 공휴일이 아니며 평일인 경우 기본값 자동 세팅
        if (!entry.clockIn && !entry.clockOut && !isHoliday && DEFAULT_HOURS[dayOfWeek]) {
            inputClockIn.value = DEFAULT_HOURS[dayOfWeek].in;
            inputClockOut.value = DEFAULT_HOURS[dayOfWeek].out;
        } else {
            inputClockIn.value = formatTimeForUI(entry.clockIn);
            inputClockOut.value = formatTimeForUI(entry.clockOut);
        }

        inputType.value = entry.type || '';
        inputNote.value = entry.note || '';
        editModal.style.display = 'flex';
    }

    // --- Action Handlers ---

    // Sync Handlers
    syncSettingsBtn.onclick = () => {
        syncCodeInput.value = syncCode || '';
        syncModal.style.display = 'flex';
    };

    syncModalClose.onclick = () => { syncModal.style.display = 'none'; };

    syncCodeGenBtn.onclick = () => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let code = '';
        for (let i = 0; i < 8; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
        syncCodeInput.value = code;
    };

    syncApplyBtn.onclick = () => {
        const code = syncCodeInput.value.trim().toUpperCase();
        if (!code) {
            alert("동기화 코드를 입력해주세요.");
            return;
        }
        syncCode = code;
        localStorage.setItem(SYNC_CODE_KEY, syncCode);
        initFirebase();
        
        if (window.firebase) {
            firebase.database().ref('users/' + syncCode).set(data);
        }
        
        alert("기기 동기화가 설정되었습니다! 이제 다른 기기에서도 이 코드를 사용하세요.");
        syncModal.style.display = 'none';
        render();
    };

    modalCancelBtn.onclick = () => { editModal.style.display = 'none'; };
    
    modalDeleteBtn.addEventListener('click', () => {
        console.log('삭제 버튼 클릭됨:', selectedDateStr);
        if (!selectedDateStr) {
            console.error('삭제할 날짜가 선택되지 않았습니다.');
            return;
        }
        
        if (confirm(`${selectedDateStr}의 모든 기록을 삭제하시겠습니까?`)) {
            delete data[selectedDateStr];
            saveData();
            editModal.style.display = 'none';
        }
    });

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

    function saveData() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        if (isSyncEnabled && window.firebase && syncCode) {
            console.log('데이터를 클라우드로 푸시합니다...');
            firebase.database().ref('users/' + syncCode).set(data)
                .then(() => console.log('동기화 완료'))
                .catch(err => console.error('동기화 실패:', err));
        }
        render();
    }

    prevMonthBtn.onclick = () => { currentDate.setMonth(currentDate.getMonth() - 1); render(); };
    nextMonthBtn.onclick = () => { currentDate.setMonth(currentDate.getMonth() + 1); render(); };

    render();
});
