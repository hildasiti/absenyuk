// Service worker ini WAJIB berada di ROOT domain (bukan di dalam
// subfolder), supaya scope-nya mencakup seluruh situs. File ini yang
// menangani notifikasi saat browser/tab sedang TERTUTUP (background).
//
// GANTI 6 nilai di bawah dengan firebaseConfig yang SAMA PERSIS dengan
// yang ada di index.html.

importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCWTg7mrM35xTifB-r_gc9HHirgEATpcBU",
  authDomain: "absenyuk-2c7a6.firebaseapp.com",
  projectId: "absenyuk-2c7a6",
  storageBucket: "absenyuk-2c7a6.firebasestorage.app",
  messagingSenderId: "842486377837",
  appId: "1:842486377837:web:88c715b23d7ab5c86d7e64"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const judul = (payload.notification && payload.notification.title) || 'AbsenYuk!';
  const opsi = {
    body: (payload.notification && payload.notification.body) || '',
    icon: '/absenyuk.png'
  };
  self.registration.showNotification(judul, opsi);
});
