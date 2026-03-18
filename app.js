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
    // 설정 데이터 구조 보장 (기존 데이터 유지하며 부족한 필드만 채움)
    if (!data._config) data._config = {};
    if (data._config.vacationBudget === undefined) data._config.vacationBudget = 0;
    
    let holidays = window.KOREA_HOLIDAYS || {}; 
    let isSyncEnabled = false;
    let syncCode = localStorage.getItem(SYNC_CODE_KEY);
    
    // --- Utility: 데이터 병합 함수 (타임스탬프 기반) ---
    function mergeData(local, remote) {
        if (!remote) return local;
        const merged = { ...local };
        for (const key in remote) {
            if (!local[key]) {
                merged[key] = remote[key];
            } else {
                // 타임스탬프 기준으로 어느 쪽이 더 최신인지 판단
                const localT = local[key].updatedAt || 0;
                const remoteT = remote[key].updatedAt || 0;
                if (remoteT >= localT) {
                    merged[key] = remote[key];
                }
            }
        }
        return merged;
    }

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
        databaseURL: "https://realtime-database-1c2ae-default-rtdb.asia-southeast1.firebasedatabase.app"
    };

    const syncStatusIndicator = document.getElementById('sync-status-indicator');

    function updateSyncStatus(status) {
        if (!syncStatusIndicator) return;
        switch(status) {
            case 'connected':
                syncStatusIndicator.style.background = '#10b981'; // 녹색: 성공
                syncStatusIndicator.title = '동기화 연결됨';
                break;
            case 'connecting':
                syncStatusIndicator.style.background = '#f59e0b'; // 노란색: 연결 중
                syncStatusIndicator.title = '서버 연결 중...';
                break;
            case 'error':
                syncStatusIndicator.style.background = '#ef4444'; // 빨간색: 오류
                syncStatusIndicator.title = '연결 지연/오류 (네트워크 확인)';
                break;
            default:
                syncStatusIndicator.style.background = '#94a3b8'; // 회색: 미설정
                syncStatusIndicator.title = '동기화 미설정';
        }
    }

    function initFirebase() {
        console.log('Firebase 연결 시도...');
        if (!window.firebase) {
            console.warn('Firebase SDK 기다리는 중...');
            updateSyncStatus('connecting');
            // SDK가 늦게 로드될 수도 있으므로 1초 후 재시도
            setTimeout(initFirebase, 1000);
            return;
        }
        
        updateSyncStatus('connecting');

        if (!firebase.apps.length) {
            try {
                firebase.initializeApp(firebaseConfig);
            } catch (err) {
                console.error('Firebase 초기화 오류:', err);
                updateSyncStatus('error');
                return;
            }
        }
        isSyncEnabled = true;
        
        // 연결 상태 감시 (실시간 피드백)
        let connectionTimeout = setTimeout(() => {
            if (syncStatusIndicator.style.background.includes('rgb(245, 158, 11)')) { // Still yellow
                console.warn('연결 지연 중... 테더링 네트워크 확인 필요');
                updateSyncStatus('error');
            }
        }, 10000); // 10초 후에도 노란색이면 빨간색으로 변경

        firebase.database().ref(".info/connected").on("value", (snap) => {
            if (snap.val() === true) {
                clearTimeout(connectionTimeout);
                console.log('Firebase 서버와 실시간 통신 성공!');
                updateSyncStatus('connected');
            } else {
                console.warn('Firebase 서버와 연결이 끊겼습니다.');
                // 즉시 에러로 바꾸지 않고 노란색으로 대기
                updateSyncStatus('connecting');
            }
        });

        const dbRef = firebase.database().ref('users/' + syncCode);
        
        // 원격 데이터 수신 로직 (tombstone 방식)
        dbRef.on('value', (snapshot) => {
            const remoteData = snapshot.val();
            if (remoteData) {
                console.log('클라우드 데이터 수신 및 병합...');
                const prevDataStr = JSON.stringify(data);
                data = mergeData(data, remoteData);
                if (JSON.stringify(data) !== prevDataStr) {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
                    render();
                }
            }
        }, (error) => {
            console.error('Firebase 읽기 권한 오류:', error);
            updateSyncStatus('error');
        });

        // 초기 데이터 업로드 보장
        dbRef.once('value').then(snap => {
            if (!snap.exists() && Object.keys(data).length > 0) {
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
    
    // File Sync UI Elements
    const btnExport = document.getElementById('btn-export');
    const btnImportTrigger = document.getElementById('btn-import-trigger');
    const inputFileImport = document.getElementById('input-file-import');

    const inputVacationBudget = document.getElementById('input-vacation-budget');
    const btnVacationSave = document.getElementById('btn-vacation-save');
    const vacationTotalEl = document.getElementById('vacation-total');
    const vacationRemainingEl = document.getElementById('vacation-remaining');
    const btnVacationDetail = document.getElementById('btn-vacation-detail');
    const vacationModal = document.getElementById('vacation-modal');
    const vacationModalTitle = document.getElementById('vacation-modal-title');
    const vacationList = document.getElementById('vacation-list');
    const vacationModalClose = document.getElementById('vacation-modal-close');

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

    // (중복 선언 방지를 위해 하단으로 통합 이동됨)

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

        // 4. Calculate Vacation Stats
        calculateVacationStats();
    }

    function calculateVacationStats() {
        if (!vacationTotalEl || !vacationRemainingEl) return;

        let usedDays = 0;
        let details = []; // 디버깅 상세 내역
        const currentYear = currentDate.getFullYear();
        const currentMonth = currentDate.getMonth(); // 0(1월) ~ 11(12월)
        
        Object.keys(data).forEach(dateStr => {
            if (dateStr.startsWith('_')) return;
            
            const [y, m, d] = dateStr.split('-').map(Number);
            // 같은 연도이면서, 1월부터 현재 조회 중인 월(m-1)까지만 합산
            if (y === currentYear && (m - 1) <= currentMonth) {
                const entry = data[dateStr];
                if (entry._deleted) return; // tombstone 항목 건너뜀
                const type = entry.type || '';
                
                if (type === '휴가') {
                    usedDays += 1;
                    details.push(`${dateStr}: 1.0 (${type})`);
                } else if (type === '반차' || type.includes('반차') || type === '휴가(4h)') {
                    // '반차', '반차(4h)', '휴가(4h)'인 경우만 0.5일로 인정
                    usedDays += 0.5;
                    details.push(`${dateStr}: 0.5 (${type})`);
                }
            }
        });
        
        console.group(`${currentYear}년 ${currentMonth + 1}월까지 누적 휴가 사용 내역 (총 ${usedDays}일)`);
        details.forEach(line => console.log(line));
        console.groupEnd();
        
        const budget = data._config.vacationBudget || 0;
        const remaining = budget - usedDays;
        
        // 소수점이 있을 경우 0.5 단위이므로 깔끔하게 표시
        const displayRemaining = Number.isInteger(remaining) ? remaining : remaining.toFixed(1);
        const displayBudget = Number.isInteger(budget) ? budget : budget.toFixed(1);

        vacationTotalEl.innerText = `${displayBudget}d`;
        vacationRemainingEl.innerText = `${displayRemaining}d`;
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

        try {
            calculateStats();
        } catch (e) {
            console.error('통계 계산 오류:', e);
        }
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

        if (data[dateStr] && !data[dateStr]._deleted) {
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
        inputVacationBudget.value = data._config.vacationBudget || '';
        syncModal.style.display = 'flex';
    };

    btnVacationSave.onclick = (e) => {
        if (e) e.preventDefault();
        
        const val = inputVacationBudget.value ? inputVacationBudget.value.trim() : "";
        if (!val) {
            alert("연차 일수를 입력해주세요.");
            return;
        }
        
        const budget = Number(val);
        if (isNaN(budget)) {
            alert("숫자로 올바르게 입력해주세요.");
            return;
        }

        // 1. 내부 데이터 업데이트
        data._config.vacationBudget = budget;
        data._config.updatedAt = Date.now();
        
        // 2. 우선적으로 화면 갱신 및 모달 닫기 (사용자 반응성)
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        calculateStats();
        syncModal.style.display = 'none';
        
        // 3. 백그라운드에서 클라우드 동기화 시도
        if (isSyncEnabled && window.firebase && syncCode) {
            try {
                const dbRef = firebase.database().ref('users/' + syncCode);
                dbRef.set(data)
                    .then(() => console.log('연차 정보 클라우드 동기화 완료'))
                    .catch(err => console.error('연차 정보 동기화 실패:', err));
            } catch (err) {
                console.error('Firebase 접근 오류:', err);
            }
        }
        
        alert(`총 연차가 ${budget}일로 설정되었습니다.`);
    };

    syncModalClose.onclick = () => { syncModal.style.display = 'none'; };

    // Vacation Detail Modal Handlers
    btnVacationDetail.onclick = () => {
        const currentYear = currentDate.getFullYear();
        const currentMonth = currentDate.getMonth(); // 0-based
        vacationModalTitle.innerText = `${currentYear}년 ${currentMonth + 1}월까지 사용 내역`;
        
        let html = '';
        let usedCount = 0;
        let details = [];
        
        // 현재 로직과 동일하게 필터링하여 리스트 생성
        Object.keys(data).sort().forEach(dateStr => {
            if (dateStr.startsWith('_')) return;
            const [y, m, d] = dateStr.split('-').map(Number);
            if (y === currentYear && (m-1) <= currentMonth) {
                const entry = data[dateStr];
                const type = entry.type || '';
                if (type === '휴가') {
                    details.push(`📅 ${dateStr}: <b style="color:#f43f5e">1.0일</b> (${type})`);
                    usedCount += 1;
                } else if (type === '반차' || type.includes('반차') || type === '휴가(4h)') {
                    details.push(`📅 ${dateStr}: <b style="color:#0ea5e9">0.5일</b> (${type})`);
                    usedCount += 0.5;
                }
            }
        });
        
        if (details.length === 0) {
            html = '<div style="text-align:center; opacity:0.5; padding:2rem;">기록된 휴가 내역이 없습니다.</div>';
        } else {
            html = details.join('<br>') + `<hr style="margin:1rem 0; border:0; border-top:1px solid rgba(255,255,255,0.1);"><b>합계: ${usedCount}일</b>`;
        }
        
        vacationList.innerHTML = html;
        vacationModal.style.display = 'flex';
    };

    vacationModalClose.onclick = () => {
        vacationModal.style.display = 'none';
    };

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
        if (syncModal) syncModal.style.display = 'none';
        render();
    };

    modalCancelBtn.onclick = () => { editModal.style.display = 'none'; };
    
    modalDeleteBtn.addEventListener('click', () => {
        if (!selectedDateStr) return;
        
        if (confirm(`${selectedDateStr}의 모든 기록을 삭제하시겠습니까?`)) {
            // Tombstone 패턴: 실제 삭제 대신 삭제 마커를 남김
            data[selectedDateStr] = { 
                _deleted: true, 
                updatedAt: Date.now() 
            };
            
            saveData(selectedDateStr); // Firebase에 tombstone을 즉시 동기화
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

        // 새 데이터 저장 시 tombstone 초기화 (삭제 후 재추가 지원)
        if (!data[selectedDateStr] || data[selectedDateStr]._deleted) {
            data[selectedDateStr] = {};
        }
        data[selectedDateStr].type = inputType.value;
        data[selectedDateStr].clockIn = ci;
        data[selectedDateStr].clockOut = co;
        data[selectedDateStr].note = inputNote.value;
        data[selectedDateStr].updatedAt = Date.now(); // 수정 시간 기록
        
        if (!inputType.value && !ci && !co && !inputNote.value) {
            delete data[selectedDateStr];
            // 삭제 로직은 별도의 삭제 버튼에서 처리하지만, 여기서도 삭제 처리 시 클라우드 반영 필요할 수 있음
        }

        saveData(selectedDateStr); // 변경된 날짜만 동기화
        editModal.style.display = 'none';
    };

    // targetDateStr이 인자로 오면 해당 날짜만 부분 업데이트, 없으면 전체 데이터 업로드
    function saveData(targetDateStr = null) {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
        
        if (isSyncEnabled && window.firebase && syncCode) {
            const dbRef = firebase.database().ref('users/' + syncCode);
            
            if (targetDateStr && data[targetDateStr]) {
                console.log(`${targetDateStr} 데이터만 부분 동기화 중...`);
                dbRef.child(targetDateStr).update(data[targetDateStr])
                    .catch(err => console.error('부분 동기화 실패:', err));
            } else if (targetDateStr === false) {
                // 단순 로컬 저장용 (삭제 등 이미 처리된 경우)
                console.log('로컬 저장 완료');
            } else {
                console.log('전체 데이터를 클라우드로 푸시합니다...');
                dbRef.set(data)
                    .then(() => console.log('전체 동기화 완료'))
                    .catch(err => console.error('전체 동기화 실패:', err));
            }
        }
        render();
    }

    prevMonthBtn.onclick = () => { currentDate.setMonth(currentDate.getMonth() - 1); render(); };
    nextMonthBtn.onclick = () => { currentDate.setMonth(currentDate.getMonth() + 1); render(); };

    // --- File-based Backup & GitHub Sync ---

    // 1. 데이터 내보내기 (JSON 다운로드)
    btnExport.onclick = () => {
        const dataStr = JSON.stringify(data, null, 2);
        const blob = new Blob([dataStr], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'data.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        alert("데이터가 data.json 파일로 다운로드되었습니다.\n이 파일을 폴더에 넣고 GitHub에 올리면 모바일에서 불러올 수 있습니다.");
    };

    // 2. 데이터 가져오기 (파일 선택)
    btnImportTrigger.onclick = () => inputFileImport.click();
    inputFileImport.onchange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        const reader = new FileReader();
        reader.onload = (event) => {
            try {
                const importedData = JSON.parse(event.target.result);
                if (confirm("파일에서 데이터를 불러오시겠습니까? 기존 데이터와 합쳐집니다. (최신 수정본 우선)")) {
                    data = mergeData(data, importedData);
                    saveData();
                    alert("데이터를 성공적으로 불러왔습니다!");
                }
            } catch (err) {
                alert("올바른 JSON 파일이 아닙니다.");
            }
        };
        reader.readAsText(file);
    };

    // 3. 서버(GitHub)에 있는 data.json 자동 감지
    async function checkServerData() {
        try {
            const response = await fetch('./data.json', { cache: 'no-store' });
            if (response.ok) {
                const serverData = await response.json();
                const serverStr = JSON.stringify(serverData);
                const localStr = JSON.stringify(data);

                if (serverStr !== localStr) {
                    if (confirm("GitHub 서버에서 새로운 데이터 파일(data.json)이 감지되었습니다. 업데이트하시겠습니까? (최신 수정본 우선 병합)")) {
                        // 타임스탬프 기반 병합 적용
                        data = mergeData(data, serverData);
                        saveData();
                    }
                }
            }
        } catch (e) {
            // data.json이 없으면 조용히 넘어감
        }
    }

    render();

    // 초기 실행 시 동기화 코드 있으면 시작
    if (syncCode) {
        initFirebase();
    }
    
    // 2초 후 서버 데이터(data.json) 한번 체크
    setTimeout(checkServerData, 2000);
});
