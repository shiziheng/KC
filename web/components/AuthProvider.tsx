'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, clearToken, readToken, writeToken } from '@/lib/api';

export type User = {
  id?: number;
  email: string;
  /** 账户余额（分 · 美元） */
  balance: number;
  commission_balance: number;
  plan_id: number | null;
  expired_at: number | null;
};

type AuthResult = { ok: boolean; message: string };

type AuthContextValue = {
  user: User | null;
  /** 首次判定登录态期间为 true —— 用它可以避免「先显示未登录、再跳成已登录」的闪动 */
  loading: boolean;
  loggedIn: boolean;
  refresh: () => Promise<User | null>;
  login: (email: string, password: string) => Promise<AuthResult>;
  register: (email: string, password: string, inviteCode?: string) => Promise<AuthResult>;
  logout: () => void;
  changePassword: (oldPassword: string, newPassword: string) => Promise<AuthResult>;
};

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  /** 拉取当前用户；令牌失效则清除 */
  const refresh = useCallback(async (): Promise<User | null> => {
    if (!readToken()) {
      setUser(null);
      setLoading(false);
      return null;
    }
    const res = await api.get<User>('/v1/user/info');
    if (res.ok && res.data) {
      setUser(res.data);
      setLoading(false);
      return res.data;
    }
    // 401/403 说明令牌已失效，清掉避免后续请求继续带无效令牌
    if (res.status === 401 || res.status === 403) {
      clearToken();
    }
    setUser(null);
    setLoading(false);
    return null;
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(
    async (email: string, password: string): Promise<AuthResult> => {
      const res = await api.post<{ token: string; auth_data: string }>(
        '/v1/passport/auth/login',
        { email, password },
        { auth: false }
      );
      if (!res.ok || !res.data) {
        return { ok: false, message: res.message || '登录失败，请检查邮箱和密码' };
      }
      // auth_data 已带 "Bearer " 前缀，直接存
      writeToken(res.data.auth_data || res.data.token);
      const u = await refresh();
      return u ? { ok: true, message: '' } : { ok: false, message: '登录成功但获取用户信息失败，请刷新重试' };
    },
    [refresh]
  );

  const register = useCallback(
    async (email: string, password: string, inviteCode?: string): Promise<AuthResult> => {
      const body: Record<string, string> = { email, password };
      if (inviteCode) body.invite_code = inviteCode;
      const res = await api.post<{ token: string; auth_data: string }>(
        '/v1/passport/auth/register',
        body,
        { auth: false }
      );
      if (!res.ok || !res.data) {
        return { ok: false, message: res.message || '注册失败，请稍后重试' };
      }
      writeToken(res.data.auth_data || res.data.token);
      const u = await refresh();
      return u ? { ok: true, message: '' } : { ok: false, message: '注册成功但获取用户信息失败，请刷新重试' };
    },
    [refresh]
  );

  const logout = useCallback(() => {
    clearToken();
    setUser(null);
  }, []);

  const changePassword = useCallback(
    async (oldPassword: string, newPassword: string): Promise<AuthResult> => {
      const res = await api.post('/v1/user/changePassword', {
        old_password: oldPassword,
        new_password: newPassword,
      });
      if (!res.ok) return { ok: false, message: res.message || '修改失败，请检查旧密码是否正确' };
      return { ok: true, message: '' };
    },
    []
  );

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      loading,
      loggedIn: !!user,
      refresh,
      login,
      register,
      logout,
      changePassword,
    }),
    [user, loading, refresh, login, register, logout, changePassword]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内使用');
  return ctx;
}
