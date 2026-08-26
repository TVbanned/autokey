import { useState } from 'react'
import { supabase } from './supabase'

const ADMIN_SESSION_KEY = 'keyflow_admin_session'

export default function AdminLoginPage() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async (event) => {
    event.preventDefault(); setError('')
    if (!username.trim()) { setError('请输入用户名'); return }
    if (!password) { setError('请输入密码'); return }
    setLoading(true)
    const { data, error: rpcErr } = await supabase.rpc('keyflow_admin_login', {
      p_username: username.trim(),
      p_password: password,
    })
    setLoading(false)
    if (rpcErr) { setError(rpcErr.message); return }
    localStorage.setItem(ADMIN_SESSION_KEY, JSON.stringify(data))
    try { sessionStorage.removeItem('KEYFLOW_ADMIN_FORCE_LOGIN') } catch {}
    window.location.href = window.location.pathname + '?admin'
  }

  return <div className="admin-login-wrapper">
    <div className="admin-login-card">
      <div className="admin-login-header">
        <a href="?home" style={{textDecoration:'none',color:'inherit'}}><span className="brand-mark zhihu-mark">知</span>
        <h1>GameJourney 管理后台</h1></a>
        <p>请输入管理员账号登录</p>
      </div>
      <form className="admin-login-form" onSubmit={handleLogin}>
        <label className="admin-login-field">
          <span>用户名</span>
          <input required value={username} placeholder="请输入管理员用户名" onChange={(e) => setUsername(e.target.value)} autoFocus />
        </label>
        <label className="admin-login-field">
          <span>密码</span>
          <input type="password" required value={password} placeholder="请输入密码" onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="admin-login-error">{error}</p>}
        <button className="admin-login-submit" type="submit" disabled={loading}>{loading ? '登录中…' : '登录'}</button>
      </form>
    </div>
  </div>
}
