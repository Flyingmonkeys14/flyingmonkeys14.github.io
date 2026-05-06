import { useState, useRef, useEffect } from "react";

// SHA-256 of "FRC469" — never store the plain password in source
const PASSWORD_HASH = "41a14320fda167e95246c8d252eef9ad339b94a75790ae5169856195a6d63ea0";
const SESSION_KEY = "oas_auth";

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const hashBuf = await crypto.subtle.digest("SHA-256", encoded);
  return Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function isAuthenticated(): boolean {
  return sessionStorage.getItem(SESSION_KEY) === "1";
}

interface PasswordGateProps {
  onAuth: () => void;
}

export function PasswordGate({ onAuth }: PasswordGateProps) {
  const [value, setValue] = useState("");
  const [error, setError] = useState(false);
  const [checking, setChecking] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!value || checking) return;
    setChecking(true);
    setError(false);

    const hash = await sha256Hex(value);
    if (hash === PASSWORD_HASH) {
      sessionStorage.setItem(SESSION_KEY, "1");
      onAuth();
    } else {
      setError(true);
      setValue("");
      setChecking(false);
      inputRef.current?.focus();
    }
  };

  return (
    <div className="auth-overlay">
      <div className="auth-card">
        <img src="/logo.svg" alt="469 Las Guerrillas" className="auth-logo-img" />
        <h1 className="auth-title">Online AdvantageScope</h1>
        <p className="auth-sub">Team 469 &middot; Las Guerrillas</p>
        <p className="auth-sub" style={{ marginTop: -4, fontSize: 12 }}>Enter the access password to continue</p>
        <form onSubmit={handleSubmit} className="auth-form">
          <input
            ref={inputRef}
            type="password"
            className={`auth-input ${error ? "error" : ""}`}
            placeholder="Password"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(false);
            }}
            autoComplete="current-password"
          />
          {error && <p className="auth-error">Incorrect password. Try again.</p>}
          <button type="submit" className="auth-btn" disabled={!value || checking}>
            {checking ? "Checking…" : "Enter"}
          </button>
        </form>
      </div>
    </div>
  );
}
