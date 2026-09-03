// Type definitions for browser client context
export interface ClientContext {
  slots: {
    inject(name: string, callback: () => void): void;
    register(options: { name: string; id: string; order?: number; label?: () => string }, component: any): void;
  };
}

export const inject = ['slots'];

export function apply(ctx: ClientContext): void {
  // @ts-ignore
  const reactModule = typeof window !== 'undefined' && (window as any).React ? (window as any).React : (typeof react !== 'undefined' ? react : null);

  function AgySection() {
    if (!reactModule) {
      return null;
    }

    const [status, setStatus] = reactModule.useState(null);
    const [loading, setLoading] = reactModule.useState(false);
    const [verifying, setVerifying] = reactModule.useState(false);
    const [message, setMessage] = reactModule.useState('');

    const loadStatus = async () => {
      setLoading(true);
      try {
        const res = await fetch('/api/dsh-agy/status');
        const json = await res.json();
        if (json.ok) {
          setStatus(json.value);
        }
      } catch (err: any) {
        setMessage('无法连接宿主接口: ' + (err.message || String(err)));
      } finally {
        setLoading(false);
      }
    };

    reactModule.useEffect(() => {
      loadStatus();
      const timer = setInterval(() => {
        if (document.visibilityState === 'visible') {
          loadStatus();
        }
      }, 10_000);
      return () => clearInterval(timer);
    }, []);

    const handleLogin = async () => {
      setMessage('');
      try {
        const res = await fetch('/api/dsh-agy/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const json = await res.json();
        if (json.ok && json.value?.started) {
          setMessage('已在桌面弹出系统终端，请在终端窗口完成 Antigravity 登录。');
        } else {
          setMessage('无法自动弹出终端，请手动在终端中运行 agy 进行登录。');
        }
      } catch (err: any) {
        setMessage('启动登录终端失败: ' + (err.message || String(err)));
      }
    };

    const handleVerify = async () => {
      setVerifying(true);
      setMessage('正在向 Antigravity CLI 发送验证请求...');
      try {
        const res = await fetch('/api/dsh-agy/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        });
        const json = await res.json();
        if (json.ok && json.value?.authenticated) {
          setMessage('凭据验证通过！Antigravity CLI 模型可正常调用。');
          loadStatus();
        } else {
          setMessage('凭据验证未通过: ' + (json.value?.error || '未登录或会话已过期'));
        }
      } catch (err: any) {
        setMessage('验证调用失败: ' + (err.message || String(err)));
      } finally {
        setVerifying(false);
      }
    };

    const e = reactModule.createElement;

    return e(
      'div',
      {
        style: {
          padding: '20px',
          maxWidth: '720px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        },
      },
      e('h2', { style: { margin: 0, fontSize: '18px', fontWeight: 600 } }, 'Antigravity CLI (agy) 提供商设置'),
      e(
        'p',
        { style: { margin: 0, color: 'var(--dsw-alias-label-secondary, #666)', fontSize: '13px', lineHeight: 1.6 } },
        '将本机已登录的 Antigravity CLI (agy) 无头会话作为 DeepSeek Harness 的模型后端，主会话模型与子代理模型通用。',
      ),
      status &&
        e(
          'div',
          {
            style: {
              background: 'var(--dsw-alias-bg-layer-2, #f5f5f5)',
              border: '1px solid var(--dsw-alias-border-l2, #e0e0e0)',
              borderRadius: '8px',
              padding: '14px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '10px',
              fontSize: '13px',
            },
          },
          e(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between' } },
            e('span', { style: { color: 'var(--dsw-alias-label-secondary, #666)' } }, '安装状态'),
            e(
              'strong',
              { style: { color: status.installed ? 'var(--dsw-alias-label-success, #2e7d32)' : 'var(--dsw-alias-label-danger, #d32f2f)' } },
              status.installed ? `已安装 (${status.version || '未知版本'})` : '未检测到 agy',
            ),
          ),
          e(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between' } },
            e('span', { style: { color: 'var(--dsw-alias-label-secondary, #666)' } }, '程序路径'),
            e('code', { style: { fontSize: '12px' } }, status.agyPath || 'agy'),
          ),
          e(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between' } },
            e('span', { style: { color: 'var(--dsw-alias-label-secondary, #666)' } }, '沙盒缓存目录'),
            e('code', { style: { fontSize: '12px' } }, status.scratchDir),
          ),
          e(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between' } },
            e('span', { style: { color: 'var(--dsw-alias-label-secondary, #666)' } }, '本地凭据缓存'),
            e('span', {}, status.hasCachedAuth ? '已检测到凭据目录 (~/.gemini)' : '未检测到凭据'),
          ),
        ),
      e(
        'div',
        { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } },
        e(
          'button',
          {
            onClick: handleLogin,
            style: {
              padding: '8px 16px',
              borderRadius: '6px',
              background: 'var(--dsw-alias-button-info-fill, #1976d2)',
              color: '#fff',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 500,
              fontSize: '13px',
            },
          },
          '打开登录终端',
        ),
        e(
          'button',
          {
            onClick: handleVerify,
            disabled: verifying,
            style: {
              padding: '8px 16px',
              borderRadius: '6px',
              background: 'var(--dsw-alias-bg-layer-2, #f0f0f0)',
              color: 'var(--dsw-alias-label-primary, #333)',
              border: '1px solid var(--dsw-alias-border-l2, #ccc)',
              cursor: verifying ? 'wait' : 'pointer',
              fontSize: '13px',
            },
          },
          verifying ? '正在验证...' : '验证登录凭据',
        ),
        e(
          'button',
          {
            onClick: loadStatus,
            disabled: loading,
            style: {
              padding: '8px 12px',
              borderRadius: '6px',
              background: 'transparent',
              color: 'var(--dsw-alias-label-secondary, #666)',
              border: 'none',
              cursor: 'pointer',
              fontSize: '13px',
            },
          },
          loading ? '刷新中...' : '刷新状态',
        ),
      ),
      message &&
        e(
          'div',
          {
            style: {
              padding: '10px 14px',
              borderRadius: '6px',
              background: 'var(--dsw-alias-bg-layer-2, #f9f9f9)',
              borderLeft: '4px solid var(--dsw-alias-button-info-fill, #1976d2)',
              fontSize: '13px',
              lineHeight: 1.5,
            },
          },
          message,
        ),
    );
  }

  ctx.slots.inject('settings.section', () => {
    ctx.slots.register(
      {
        name: 'settings.section',
        id: 'agy',
        order: 45,
        label: () => 'Antigravity CLI',
      },
      AgySection,
    );
  });
}
