import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '@/lib/api';
import type { Health } from '@/lib/types';
import { engineBadge } from '@/lib/labels';

export function Layout({ children }: { children: React.ReactNode }) {
  const [health, setHealth] = useState<Health | null>(null);
  const location = useLocation();

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null));
  }, []);

  return (
    <div className="min-h-full">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">
              工
            </span>
            <span className="text-sm font-semibold tracking-tight">工程交付大脑 · 事实底座</span>
          </Link>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {health ? (
              <>
                {engineBadge(health.engine)}
                <span className="font-mono">{health.model ?? '规则引擎'}</span>
              </>
            ) : (
              <span className="text-muted-foreground">后端未连接</span>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-8" key={location.pathname}>
        {children}
      </main>

      <footer className="mx-auto max-w-6xl px-6 pb-10 pt-4 text-xs text-muted-foreground">
        要求基线 ↔ 承诺 ↔ 偏离 ↔ 证据 ↔ 变更 ↔ 索赔 · 一切 AI 结论可溯源到原文出处
      </footer>
    </div>
  );
}
