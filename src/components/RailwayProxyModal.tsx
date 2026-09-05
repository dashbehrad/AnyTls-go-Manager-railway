import React, { useState } from 'react';
import {
  X,
  Radio,
  Check,
  Copy,
  Activity,
  Server,
  Zap,
  HelpCircle,
  ExternalLink,
  ShieldCheck,
  Key,
  Globe,
} from 'lucide-react';
import { RailwayInfo } from '../types';
import { api } from '../lib/api';

interface RailwayProxyModalProps {
  isOpen: boolean;
  onClose: () => void;
  railwayInfo: RailwayInfo | null;
  onRefreshInfo: () => Promise<void>;
}

export const RailwayProxyModal: React.FC<RailwayProxyModalProps> = ({
  isOpen,
  onClose,
  railwayInfo,
  onRefreshInfo,
}) => {
  const [domain, setDomain] = useState(railwayInfo?.tcpProxyDomain || '');
  const [port, setPort] = useState(railwayInfo?.tcpProxyPort ? String(railwayInfo.tcpProxyPort) : '');
  const [isSaving, setIsSaving] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    reachable: boolean;
    latencyMs?: number;
    message: string;
  } | null>(null);
  const [copiedVar, setCopiedVar] = useState<string | null>(null);
  const [statusMsg, setStatusMsg] = useState('');

  React.useEffect(() => {
    if (railwayInfo) {
      setDomain(railwayInfo.tcpProxyDomain || '');
      setPort(railwayInfo.tcpProxyPort ? String(railwayInfo.tcpProxyPort) : '');
    }
  }, [railwayInfo]);

  if (!isOpen) return null;

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setStatusMsg('');
    try {
      const portNum = port ? parseInt(port, 10) : 0;
      await api.updateTcpProxy({
        tcpProxyDomain: domain.trim(),
        tcpProxyPort: isNaN(portNum) ? 0 : portNum,
      });
      await onRefreshInfo();
      setStatusMsg('تنظیمات پراکسی با موفقیت ذخیره شد');
      setTimeout(() => setStatusMsg(''), 3000);
    } catch (err: any) {
      setStatusMsg(err.message || 'خطا در ذخیره‌سازی');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const portNum = port ? parseInt(port, 10) : 0;
      const res = await api.testTcpProxy({
        domain: domain.trim(),
        port: portNum,
      });
      setTestResult(res);
    } catch (err: any) {
      setTestResult({
        success: false,
        reachable: false,
        message: err.message || 'Connection test failed',
      });
    } finally {
      setIsTesting(false);
    }
  };

  const copyText = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedVar(id);
    setTimeout(() => setCopiedVar(null), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-sm overflow-y-auto">
      <div className="relative w-full max-w-2xl rounded-2xl border border-white/10 bg-[#141414] shadow-2xl my-8 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-white/5 px-6 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-purple-500/10 text-purple-400 border border-purple-500/20">
              <Radio className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-white tracking-wide flex items-center gap-2">
                Railway & TCP Proxy Manager
                <span className="px-2 py-0.5 text-[10px] rounded-full bg-purple-500/20 text-purple-300 border border-purple-500/30">
                  Railway Optimized
                </span>
              </h2>
              <p className="text-xs text-white/50">
                مدیریت اتصال به TCP Proxy برای ساخت کانفیگ AnyTLS روی Railway
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-white/40 hover:bg-white/5 hover:text-white transition"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="max-h-[75vh] overflow-y-auto p-6 space-y-6">
          {/* Status summary banner */}
          <div className="rounded-xl border border-purple-500/20 bg-purple-500/5 p-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-purple-500/20 text-purple-300">
                  <Activity className="h-4 w-4" />
                </div>
                <div>
                  <div className="text-xs font-medium text-white/90">
                    وضعیت استقرار در کانتینر
                  </div>
                  <div className="text-[11px] text-white/50">
                    پورت داخلی AnyTLS در کانتینر: <span className="font-mono text-purple-300">8443</span>
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span
                  className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-mono font-medium ${
                    railwayInfo?.hasTcpProxy
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                      : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                  }`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      railwayInfo?.hasTcpProxy ? 'bg-emerald-400' : 'bg-amber-400'
                    }`}
                  />
                  {railwayInfo?.hasTcpProxy ? 'TCP Proxy فعال است' : 'TCP Proxy نیاز به تنظیم دارد'}
                </span>
              </div>
            </div>
          </div>

          {/* Form to update TCP Proxy Host & Port */}
          <form onSubmit={handleSave} className="space-y-4">
            <div className="text-xs font-semibold text-white/80 uppercase tracking-wider flex items-center gap-2">
              <Globe className="h-4 w-4 text-amber-500" />
              آدرس و پورت TCP Proxy
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-white/70 mb-1.5">
                  دامین پروکسی (Railway TCP Proxy Domain)
                </label>
                <input
                  type="text"
                  value={domain}
                  onChange={(e) => setDomain(e.target.value)}
                  placeholder="e.g. junction.proxy.rlwy.net"
                  className="w-full rounded-xl border border-white/10 bg-[#0d0d0d] px-3.5 py-2.5 text-sm text-white font-mono placeholder:text-white/30 focus:border-purple-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-medium text-white/70 mb-1.5">
                  پورت خارجی (Proxy Port)
                </label>
                <input
                  type="number"
                  value={port}
                  onChange={(e) => setPort(e.target.value)}
                  placeholder="e.g. 12345"
                  className="w-full rounded-xl border border-white/10 bg-[#0d0d0d] px-3.5 py-2.5 text-sm text-white font-mono placeholder:text-white/30 focus:border-purple-500 focus:outline-none"
                />
              </div>
            </div>

            {statusMsg && (
              <div className="text-xs text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-3 py-2 rounded-lg">
                {statusMsg}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2.5 pt-1">
              <button
                type="submit"
                disabled={isSaving}
                className="flex items-center gap-2 rounded-xl bg-purple-600 hover:bg-purple-500 px-4 py-2.5 text-xs sm:text-sm font-medium text-white transition shadow-lg shadow-purple-600/20 disabled:opacity-50"
              >
                {isSaving ? 'در حال ذخیره...' : 'ذخیره تنظیمات'}
              </button>

              <button
                type="button"
                onClick={handleTestConnection}
                disabled={isTesting || !domain || !port}
                className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 hover:bg-white/10 px-4 py-2.5 text-xs sm:text-sm font-medium text-white transition disabled:opacity-40"
              >
                <Zap className={`h-4 w-4 text-amber-400 ${isTesting ? 'animate-spin' : ''}`} />
                <span>{isTesting ? 'در حال تست پینگ...' : 'تست اتصال به TCP Proxy'}</span>
              </button>
            </div>
          </form>

          {/* Test connection result display */}
          {testResult && (
            <div
              className={`rounded-xl border p-4 text-xs ${
                testResult.reachable
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-red-500/30 bg-red-500/10 text-red-300'
              }`}
            >
              <div className="flex items-center gap-2 font-medium mb-1">
                {testResult.reachable ? (
                  <>
                    <Check className="h-4 w-4 text-emerald-400" />
                    <span>ارتباط موفق با Railway TCP Proxy!</span>
                    {testResult.latencyMs !== undefined && (
                      <span className="font-mono bg-emerald-500/20 px-2 py-0.5 rounded text-[11px]">
                        {testResult.latencyMs}ms
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <X className="h-4 w-4 text-red-400" />
                    <span>خطا در برقراری ارتباط</span>
                  </>
                )}
              </div>
              <p className="text-white/70 text-[11px] mt-1">{testResult.message}</p>
            </div>
          )}

          {/* Step by step Railway Tutorial */}
          <div className="rounded-xl border border-white/5 bg-[#0d0d0d] p-4 space-y-3">
            <div className="text-xs font-semibold text-white/90 flex items-center gap-2">
              <HelpCircle className="h-4 w-4 text-purple-400" />
              راهنمای راه‌اندازی TCP Proxy در سایت Railway
            </div>

            <ol className="space-y-2 text-xs text-white/70 list-decimal list-inside leading-relaxed">
              <li>
                وارد داشبورد پروژه خود در سایت{' '}
                <a
                  href="https://railway.com"
                  target="_blank"
                  rel="noreferrer"
                  className="text-purple-400 hover:underline"
                >
                  Railway.com
                </a>{' '}
                شوید.
              </li>
              <li>سرویس مربوط به این پنل را انتخاب کنید و به زبانه <strong>Settings</strong> بروید.</li>
              <li>
                در بخش <strong>Networking</strong>، گزینه <strong>TCP Proxying</strong> را پیدا کرده و روی{' '}
                <strong>Add TCP Proxy</strong> کلیک کنید.
              </li>
              <li>
                مقدار <strong>Internal Port</strong> را برابر با <code className="text-purple-300 bg-white/5 px-1 rounded font-mono">8443</code> قرار دهید.
              </li>
              <li>
                سایت Railway یک آدرس و پورت مانند <code className="text-purple-300 bg-white/5 px-1 rounded font-mono">junction.proxy.rlwy.net:12345</code> به شما می‌دهد.
              </li>
              <li>دامین و پورت دریافتی را در فرم بالا یا در متغیرهای محیطی Railway وارد کنید. تمام!</li>
            </ol>
          </div>

          {/* Environment variables reference */}
          <div className="rounded-xl border border-white/5 bg-[#0d0d0d] p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="text-xs font-semibold text-white/90 flex items-center gap-2">
                <Key className="h-4 w-4 text-amber-500" />
                متغیرهای محیطی Railway (Variables)
              </div>
              <span className="text-[10px] text-white/40">در تب Variables سرویس Railway ذخیره کنید</span>
            </div>

            <div className="space-y-2">
              {[
                { name: 'ADMIN_USERNAME', desc: 'نام کاربری ادمین پنل', defaultVal: 'admin' },
                { name: 'ADMIN_PASSWORD', desc: 'رمز عبور ادمین پنل (بدون ریست شدن هنگام دیپلوی مجدد)', defaultVal: 'your_password' },
                { name: 'RAILWAY_TCP_PROXY_DOMAIN', desc: 'دامین دریافتی از بخش TCP Proxying', defaultVal: domain || 'junction.proxy.rlwy.net' },
                { name: 'RAILWAY_TCP_PROXY_PORT', desc: 'پورت دریافتی از بخش TCP Proxying', defaultVal: port || '12345' },
                { name: 'ANYTLS_PORT', desc: 'پورت داخلی AnyTLS در کانتینر', defaultVal: '8443' },
                { name: 'SNI_DEFAULT', desc: 'دامنه پیش‌فرض برای SNI', defaultVal: 'cloudflare.com' },
              ].map((v) => (
                <div
                  key={v.name}
                  className="flex items-center justify-between gap-2 p-2 rounded-lg bg-white/[0.02] border border-white/5 hover:border-white/10 transition"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-xs text-purple-300 truncate">{v.name}</div>
                    <div className="text-[10px] text-white/50 truncate">{v.desc}</div>
                  </div>
                  <button
                    onClick={() => copyText(`${v.name}=${v.defaultVal}`, v.name)}
                    className="flex items-center gap-1 text-[11px] text-white/40 hover:text-white px-2 py-1 rounded bg-white/5"
                  >
                    {copiedVar === v.name ? (
                      <Check className="h-3 w-3 text-emerald-400" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                    <span>کپی</span>
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-white/5 px-6 py-3 bg-[#111] flex items-center justify-between">
          <div className="text-[11px] text-white/40 font-mono">
            AnyTLS Manager Panel • پنل بهینه‌شده برای Railway
          </div>
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg border border-white/10 text-xs font-medium text-white/80 hover:bg-white/5 hover:text-white transition"
          >
            بستن
          </button>
        </div>
      </div>
    </div>
  );
};
