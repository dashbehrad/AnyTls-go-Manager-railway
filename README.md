# AnyTLS Manager Panel (بهینه‌شده برای سرویس Railway)

> **پنل ساخته شده توسط aminiyt**

پنل مدیریت وب و خودکارسازی پروتکل **AnyTLS** مبتنی بر سورس رسمی [anytls/anytls-go](https://github.com/anytls/anytls-go)، با بهینه‌سازی ۱۰۰٪ برای دپلوی و اجرا روی کانتینرهای ابری **Railway** و قابلیت ساخت کانفیگ به کمک **TCP Proxy**.

---

## 🌟 امکانات پنل (Features)

- 🚀 **بهینه‌سازی کامل برای کانتینر ریلوی (Railway Optimized):** پیکربندی شده با `Dockerfile` چندلایه‌ای، فایل‌های `railway.json` و `nixpacks.toml` برای بیلد سریع و بدون خطای کانتینر.
- 🌐 **پشتیبانی کامل از TCP Proxyینگ Railway:** به دلیل ماهیت کانتینرهای ابری، اتصال AnyTLS از طریق پروکسی لایه ۴ (TCP Proxy) هدایت می‌شود تا کلاینت‌هایی مانند **NekoBox** به راحتی به پورت AnyTLS متصل شوند.
- 🔑 **متغیرهای محیطی برای احراز هویت ادمین:** قابلیت تنظیم نام کاربری (`ADMIN_USERNAME`) و پسوورد (`ADMIN_PASSWORD`) از طریق Variables در داشبورد Railway، بدون نگرانی از ریست شدن اطلاعات هنگام دپلوی مجدد (Ephemeral Storage).
- ⚙️ **دانلود و راه‌اندازی هوشمند باینری AnyTLS:** سیستم در صورت نبود فایل اجرایی `anytls-server` در کانتینر، باینری متناسب با معماری سرور (amd64 یا arm64) را به صورت کامپایل شده و آماده از گیت‌هاب دریافت کرده و پروسه‌ها را بالا می‌آورد.
- ⚡ **تست زنده اتصال TCP Proxy:** دارای ابزار داخلی تست اتصال و محاسبه پینگ/تأخیر (Latency ms) به هاست و پورت TCP Proxy ریلوی.
- 📱 **تولید خروجی برای تمام کلاینت‌ها:**
  - لینک استاندارد `anytls://`
  - کد QR برای اسکن در گوشی
  - کانفیگ سفارشی برای **NekoBox** (اندروید و ویندوز)
  - کانفیگ استاندارد JSON برای هسته **Sing-box**
  - کانفیگ YAML برای **Clash Meta / Mihomo**
- 📊 **مانیتورینگ سیستم:** نمایش لحظه‌ای میزان مصرف RAM، CPU، آپتایم، وضعیت پروسه‌ها و لاگ‌های زنده.
- 🐧 **پشتیبانی همزمان از سرور لینوکس Ubuntu:** علاوه بر Railway، قابلیت نصب تک‌کلیکه با اسکریپت `install.sh` یا فایل ZIP روی سرور شخصی اوبونتو فراهم است.

---

## 🚀 راهنمای راه‌اندازی و دپلوی در Railway (قدم به قدم)

برای راه‌اندازی این پنل روی سرویس ابری **Railway** و ساخت کانفیگ، مراحل ساده زیر را دنبال کنید:

### گام اول: ساخت پروژه در Railway
1. وارد سایت [railway.com](https://railway.com) شده و وارد حساب کاربری خود شوید.
2. روی دکمه **New Project** کلیک کنید.
3. گزینه **Deploy from GitHub repo** را انتخاب کرده و ریپازیتوری این پروژه را انتخاب نمایید.

### گام دوم: تنظیم متغیرهای محیطی (Environment Variables)
1. وارد سرویس ساخته شده در داشبورد پروژه شوید و به تب **Variables** بروید.
2. متغیرهای زیر را برای پنل خود تعریف کنید:

| نام متغیر (Variable) | مقدار نمونه | توضیحات |
|----------------------|-------------|---------|
| `ADMIN_USERNAME` | `admin` | نام کاربری برای ورود به پنل |
| `ADMIN_PASSWORD` | `یک_رمز_قوی_و_دلخواه` | رمز عبور ادمین پنل (با دپلوی مجدد تغییر نمی‌کند) |
| `PORT` | `3000` | پورت وب پنل (توسط ریلوی خودکار به دامنه متصل می‌شود) |
| `ANYTLS_PORT` | `8443` | پورت داخلی سرور AnyTLS درون کانتینر |
| `SNI_DEFAULT` | `cloudflare.com` | دامنه پیش‌فرض شبیه‌سازی TLS |

### گام سوم: فعال‌سازی TCP Proxy در Railway (بسیار مهم)
به دلیل این‌که ترافیک پروتکل AnyTLS یک ارتباط خام TCP/TLS است، باید یک TCP Proxy روی سرویس خود ایجاد کنید:

1. در صفحه تنظیمات سرویس در ریلوی، وارد زبانه **Settings** شوید.
2. به بخش **Networking** اسکرول کنید.
3. در قسمت **TCP Proxying**، روی دکمه **Add TCP Proxy** کلیک کنید.
4. در فیلد **Internal Port**، پورت AnyTLS را که در متغیرها گذاشتید وارد کنید: `8443`.
5. ریلوی یک دامین و پورت اختصاصی مانند زیر به شما تحویل می‌دهد:
   ```text
   junction.proxy.rlwy.net:12345
   ```

### گام چهارم: ذخیره مشخصات TCP Proxy در پنل
حالا دو متغیر زیر را هم در بخش **Variables** ریلوی ذخیره کنید (یا داخل خود پنل در دکمه **Railway & TCP Proxy** ثبت کنید):
```env
RAILWAY_TCP_PROXY_DOMAIN=junction.proxy.rlwy.net
RAILWAY_TCP_PROXY_PORT=12345
```

### گام پنجم: ورود به پنل و ساخت کانفیگ AnyTLS
1. به آدرس دامنه اینترنتی پنل خود (که ریلوی در بخش Public Networking ارائه داده) مراجعه کنید.
2. با نام کاربری `ADMIN_USERNAME` و رمز عبور `ADMIN_PASSWORD` وارد شوید.
3. روی دکمه **Create New Config** کلیک کنید:
   - یک نام (Remark) دلخواه بنویسید (مثلاً `MyPhone`).
   - پورت داخلی را روی `8443` بگذارید.
   - آدرس TCP Proxy شما به صورت خودکار در کانفیگ قرار می‌گیرد.
4. دکمه **Create Configuration** را بزنید.
5. روی دکمه **QR Code / Link** کلیک کنید و لینک ساخته شده را کپی کرده یا با اپلیکیشن **NekoBox** اسکن کنید!

---

## 📱 آموزش وارد کردن کانفیگ در کلاینت‌ها

### در NekoBox (اندروید و ویندوز):
1. لینک کپی شده از پنل را که به صورت زیر است کپی کنید:
   ```text
   anytls://PASSWORD@junction.proxy.rlwy.net:12345?sni=cloudflare.com&insecure=1#MyPhone
   ```
2. نرم‌افزار NekoBox را باز کنید و روی آیکون **+** بزنید و گزینه **Import from Clipboard** را انتخاب کنید.
3. روی کانفیگ کلیک کرده و متصل شوید. ترافیک شما بدون مشکل از بستر TCP Proxy و هسته AnyTLS عبور می‌کند.

### در Sing-Box:
در مودال QR Code پنل، روی زبانه **Sing-box JSON** کلیک کنید تا بلوک اوتباند استاندارد سینگ‌باکس برای شما نمایش داده شود:
```json
{
  "tag": "anytls-out",
  "type": "anytls",
  "server": "junction.proxy.rlwy.net",
  "server_port": 12345,
  "password": "YOUR_PASSWORD",
  "tls": {
    "enabled": true,
    "server_name": "cloudflare.com",
    "insecure": true
  }
}
```

---

## 📋 متغیرهای محیطی کامل (Environment Variables Reference)

| متغیر | حالت پیش‌فرض | توضیحات |
|-------|--------------|---------|
| `ADMIN_USERNAME` | `admin` | نام کاربری پنل ادمین |
| `ADMIN_PASSWORD` | `admin123456` | رمز عبور پنل ادمین |
| `PORT` | `3000` | پورت وب اپلیکیشن |
| `RAILWAY_TCP_PROXY_DOMAIN` | *(خالی)* | آدرس دامنه TCP Proxy دریافتی از ریلوی |
| `RAILWAY_TCP_PROXY_PORT` | `0` | پورت TCP Proxy دریافتی از ریلوی |
| `ANYTLS_PORT` | `8443` | پورت لیسن داخلی هسته AnyTLS در کانتینر |
| `SNI_DEFAULT` | `cloudflare.com` | اس‌ان‌آی پیش‌فرض در ساخت کانفیگ‌ها |

---

## 🐧 نصب روی سرور لینوکس اوبونتو (روش سنتی VPS)

اگر علاوه بر Railway مایل هستید پنل را روی سرور مجازی اختصاصی اوبونتو اجرا کنید:

```bash
git clone https://github.com/aminiyt1/AnyTls-go-Manager.git /opt/anytls-panel && cd /opt/anytls-panel && chmod +x install.sh bin/anytls && ./install.sh
```

یا در صورت نیاز به بازنصب:
```bash
rm -rf /opt/anytls-panel && git clone https://github.com/aminiyt1/AnyTls-go-Manager.git /opt/anytls-panel && cd /opt/anytls-panel && chmod +x install.sh bin/anytls && ./install.sh
```

### دستورات سرویس سیستم‌دی در اوبونتو:
```bash
systemctl status anytls-panel     # بررسی وضعیت سرویس
systemctl restart anytls-panel    # راه‌اندازی مجدد
journalctl -u anytls-panel -f     # مشاهده زنده لاگ‌ها
```

---

## 👨‍💻 سازنده

**پنل ساخته شده توسط aminiyt**
(AnyTLS Manager Panel by aminiyt)
