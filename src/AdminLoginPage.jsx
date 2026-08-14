import { useState } from 'react'
import { supabase } from './supabase'

export default function AdminLoginPage() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const handleLogin = async (event) => {
    event.preventDefault()
    setError('')
    if (!email.trim()) { setError('请输入管理员邮箱'); return }
    if (!password) { setError('请输入密码'); return }

    setLoading(true)
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    })
    if (signInError) {
      setLoading(false)
      setError(signInError.message)
      return
    }

    const { data: isAdmin, error: roleError } = await supabase.rpc('keyflow_is_admin')
    if (roleError || !isAdmin) {
      await supabase.auth.signOut()
      setLoading(false)
      setError('该 Auth 账号未被授予管理员角色，不能进入后台。请由数据库管理员完成 Auth 账号与 keyflow_user_roles 的绑定。')
      return
    }

    window.location.href = window.location.pathname
  }

  return <div className="admin-login-wrapper">
    <div className="admin-login-card">
      <div className="admin-login-header">
        <a href="?home" style={{textDecoration:'none',color:'inherit'}}><span className="brand-mark zhihu-mark">知</span>
        <h1>GameJourney 管理后台</h1></a>
        <p>使用已授予管理员角色的 Supabase Auth 邮箱登录</p>
      </div>
      <form className="admin-login-form" onSubmit={handleLogin}>
        <label className="admin-login-field">
          <span>邮箱</span>
          <input type="email" required value={email} placeholder="admin@example.com" onChange={(e) => setEmail(e.target.value)} autoFocus />
        </label>
        <label className="admin-login-field">
          <span>密码</span>
          <input type="password" required value={password} placeholder="输入 Auth 密码" onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="admin-login-error">{error}</p>}
        <button className="admin-login-submit" disabled={loading}>{loading ? '登录中…' : '安全登录'}</button>
      </form>
    </div>
  </div>
}
