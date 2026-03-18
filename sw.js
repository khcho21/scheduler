const CACHE_NAME = 'scheduler-v11'; // 버전을 올려 강제 갱신
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './holidays.js',
    './manifest.json',
    './icon.png',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap'
];

// 설치 시 캐시 저장
self.addEventListener('install', (e) => {
    self.skipWaiting(); // 새로운 서비스 워커가 즉시 제어권 가짐
    e.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            console.log('캐시 저장 중...');
            return cache.addAll(ASSETS);
        })
    );
});

// 활성화 시 오래된 캐시 삭제
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.map((key) => {
                    if (key !== CACHE_NAME) {
                        console.log('오래된 캐시 삭제:', key);
                        return caches.delete(key);
                    }
                })
            );
        }).then(() => self.clients.claim()) // 즉시 페이지 제어
    );
});

// 네트워크 우선 전략 (동기화 기능을 위해)
self.addEventListener('fetch', (e) => {
    e.respondWith(
        fetch(e.request).catch(() => {
            return caches.match(e.request);
        })
    );
});
