import type { ReactNode } from 'react';
import { Wordmark } from '../layout/Wordmark.js';
import './auth.css';

/** Centred card used by the sign-in and invitation screens. */
export function AuthCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <div className="auth-screen">
      <div className="auth-card">
        <Wordmark />
        <h1 className="auth-title">{title}</h1>
        <p className="auth-subtitle">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}
