import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DensityFeedClient } from '../websocket/DensityFeedClient';
import {
  getSettings,
  saveSettings,
  resetSettings,
  type AppSettings,
} from './SettingsStore';

type TestStatus = 'idle' | 'testing' | 'success' | 'failed';
type NotifPermission = 'default' | 'granted' | 'denied' | 'unsupported';

const colors = {
  bg: '#0f1420',
  panel: '#161d2e',
  panelBorder: '#232c42',
  text: '#e5e9f2',
  subtext: '#8b93a8',
  accent: '#3b82f6',
  accentHover: '#2f6fd6',
  danger: '#ef4444',
  success: '#22c55e',
  warn: '#f59e0b',
  inputBg: '#0f1420',
};

const styles: Record<string, React.CSSProperties> = {
  page: {
    minHeight: '100vh',
    backgroundColor: colors.bg,
    color: colors.text,
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    padding: '32px 24px 80px',
  },
  container: {
    maxWidth: '640px',
    margin: '0 auto',
  },
  topRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '24px',
  },
  backButton: {
    padding: '8px 14px',
    backgroundColor: 'transparent',
    color: colors.subtext,
    border: `1px solid ${colors.panelBorder}`,
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
  },
  title: {
    fontSize: '22px',
    fontWeight: 700,
    margin: '0 0 4px',
  },
  subtitle: {
    fontSize: '13px',
    color: colors.subtext,
    margin: 0,
    textAlign: 'center',
  },
  card: {
    backgroundColor: colors.panel,
    border: `1px solid ${colors.panelBorder}`,
    borderRadius: '10px',
    padding: '20px',
    marginBottom: '20px',
  },
  cardHeader: {
    fontSize: '13px',
    fontWeight: 700,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: colors.subtext,
    marginBottom: '14px',
    textAlign: 'center',
  },
  fieldLabel: {
    display: 'block',
    fontSize: '14px',
    fontWeight: 600,
    marginBottom: '6px',
    textAlign: 'center',
  },
  input: {
    width: '100%',
    padding: '10px 12px',
    borderRadius: '6px',
    border: `1px solid ${colors.panelBorder}`,
    backgroundColor: colors.inputBg,
    color: colors.text,
    fontFamily: 'monospace',
    fontSize: '13px',
    boxSizing: 'border-box',
  },
  row: {
    display: 'flex',
    gap: '10px',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: '10px',
  },
  testButton: {
    padding: '10px 14px',
    backgroundColor: 'transparent',
    color: colors.text,
    border: `1px solid ${colors.panelBorder}`,
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
    whiteSpace: 'nowrap',
  },
  toggleRowFirst: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    padding: '0 0 4px',
  },
  toggleLabel: {
    fontSize: '14px',
    fontWeight: 600,
  },
  saveBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginTop: '8px',
  },
  saveButton: {
    padding: '12px 20px',
    backgroundColor: colors.accent,
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '14px',
    fontWeight: 700,
  },
  resetButton: {
    padding: '12px 16px',
    backgroundColor: 'transparent',
    color: colors.subtext,
    border: `1px solid ${colors.panelBorder}`,
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '13px',
  },
  toast: {
    fontSize: '13px',
    color: colors.success,
  },
};

function switchStyle(checked: boolean): React.CSSProperties {
  return {
    position: 'relative',
    width: '40px',
    height: '22px',
    borderRadius: '11px',
    backgroundColor: checked ? colors.accent : '#2a3348',
    border: 'none',
    cursor: 'pointer',
    flexShrink: 0,
    transition: 'background-color 0.15s ease',
  };
}

function switchKnobStyle(checked: boolean): React.CSSProperties {
  return {
    position: 'absolute',
    top: '2px',
    left: checked ? '20px' : '2px',
    width: '18px',
    height: '18px',
    borderRadius: '50%',
    backgroundColor: '#fff',
    transition: 'left 0.15s ease',
  };
}

function statusPill(status: TestStatus): { label: string; color: string } {
  switch (status) {
    case 'testing':
      return { label: 'Connecting…', color: colors.warn };
    case 'success':
      return { label: 'Connected', color: colors.success };
    case 'failed':
      return { label: 'Unreachable', color: colors.danger };
    default:
      return { label: 'Not tested', color: colors.subtext };
  }
}

function permissionLabel(p: NotifPermission): { label: string; color: string } {
  switch (p) {
    case 'granted':
      return { label: 'Allowed', color: colors.success };
    case 'denied':
      return { label: 'Blocked in browser', color: colors.danger };
    case 'unsupported':
      return { label: 'Not supported by this browser', color: colors.subtext };
    default:
      return { label: 'Not requested yet', color: colors.subtext };
  }
}

export const Settings: React.FC = () => {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<AppSettings>(() => getSettings());
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [testStatus, setTestStatus] = useState<TestStatus>('idle');
  const [notifPermission, setNotifPermission] = useState<NotifPermission>(() =>
    typeof Notification === 'undefined'
      ? 'unsupported'
      : (Notification.permission as NotifPermission)
  );

  const testClientRef = useRef<DensityFeedClient | null>(null);
  const testTimeoutRef = useRef<number | null>(null);
  const closeTimeoutRef = useRef<number | null>(null);

  const cleanupTest = () => {
    if (testTimeoutRef.current !== null) {
      window.clearTimeout(testTimeoutRef.current);
      testTimeoutRef.current = null;
    }
    if (closeTimeoutRef.current !== null) {
      window.clearTimeout(closeTimeoutRef.current);
      closeTimeoutRef.current = null;
    }
    if (testClientRef.current) {
      testClientRef.current.close();
      testClientRef.current = null;
    }
  };

  useEffect(() => cleanupTest, []);

  const handleChange = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  };

  const handleTestConnection = () => {
    cleanupTest();
    setTestStatus('testing');

    const client = new DensityFeedClient(draft.wsEndpoint);
    testClientRef.current = client;

    const unsubscribe = client.onStatusChange((status) => {
      if (status === 'open') {
        setTestStatus('success');
        unsubscribe();
        if (testTimeoutRef.current !== null) {
          window.clearTimeout(testTimeoutRef.current);
          testTimeoutRef.current = null;
        }
        // It's just a probe -- close shortly after confirming it opened.
        closeTimeoutRef.current = window.setTimeout(() => {
          client.close();
          if (testClientRef.current === client) testClientRef.current = null;
        }, 500);
      }
    });

    testTimeoutRef.current = window.setTimeout(() => {
      setTestStatus('failed');
      unsubscribe();
      client.close();
      if (testClientRef.current === client) testClientRef.current = null;
    }, 5000);
  };

  const handleTogglePushNotifications = async (checked: boolean) => {
    handleChange('pushNotificationsEnabled', checked);
    if (!checked) return;
    if (typeof Notification === 'undefined') {
      setNotifPermission('unsupported');
      return;
    }
    const result = await Notification.requestPermission();
    setNotifPermission(result as NotifPermission);
  };

  const handleSave = () => {
    saveSettings(draft);
    setSavedAt(Date.now());
    window.setTimeout(() => setSavedAt(null), 2500);
  };

  const handleReset = () => {
    const defaults = resetSettings();
    setDraft(defaults);
    setTestStatus('idle');
  };

  const pill = statusPill(testStatus);
  const notif = permissionLabel(notifPermission);
  const urlLooksValid = /^wss?:\/\/.+/.test(draft.wsEndpoint.trim());

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <div style={styles.topRow}>
          <div>
            <h1 style={styles.title}>Settings</h1>
            <p style={styles.subtitle}>Dashboard connection, alerts, and notifications</p>
          </div>
          <button style={styles.backButton} onClick={() => navigate('/')}>
            ← Back to Dashboard
          </button>
        </div>

        {/* Connection */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>Connection</div>

          <label style={styles.fieldLabel}>Density Feed Endpoint</label>
          <input
            type="text"
            value={draft.wsEndpoint}
            onChange={(e) => handleChange('wsEndpoint', e.target.value)}
            style={{
              ...styles.input,
              borderColor: urlLooksValid ? colors.panelBorder : colors.danger,
            }}
            spellCheck={false}
          />
          <div style={styles.row}>
            <button style={styles.testButton} onClick={handleTestConnection} disabled={!urlLooksValid}>
              Test Connection
            </button>
            <span style={{ fontSize: '13px', color: pill.color, fontWeight: 600 }}>
              ● {pill.label}
            </span>
          </div>
        </div>

        {/* Alerts */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>Alerts</div>

          <div style={styles.toggleRowFirst}>
            <div style={styles.toggleLabel}>Play sound on CRITICAL alerts</div>
            <button
              style={switchStyle(draft.soundOnCritical)}
              onClick={() => handleChange('soundOnCritical', !draft.soundOnCritical)}
              aria-pressed={draft.soundOnCritical}
            >
              <span style={switchKnobStyle(draft.soundOnCritical)} />
            </button>
          </div>
        </div>

        {/* Notifications */}
        <div style={styles.card}>
          <div style={styles.cardHeader}>Notifications</div>

          <div style={styles.toggleRowFirst}>
            <div style={styles.toggleLabel}>Browser push notifications</div>
            <button
              style={switchStyle(draft.pushNotificationsEnabled)}
              onClick={() => handleTogglePushNotifications(!draft.pushNotificationsEnabled)}
              aria-pressed={draft.pushNotificationsEnabled}
            >
              <span style={switchKnobStyle(draft.pushNotificationsEnabled)} />
            </button>
          </div>
          <div style={{ fontSize: '13px', color: notif.color, fontWeight: 600, textAlign: 'center' }}>
            ● {notif.label}
          </div>
        </div>

        <div style={styles.saveBar}>
          <button style={styles.saveButton} onClick={handleSave}>
            Save Settings
          </button>
          <button style={styles.resetButton} onClick={handleReset}>
            Reset to Defaults
          </button>
          {savedAt !== null && <span style={styles.toast}>Saved</span>}
        </div>
      </div>
    </div>
  );
};