import { supabase } from './supabase'

const VISITOR_KEY = 'keyflow_analytics_visitor_id'

const getVisitorId = () => {
  let visitorId = localStorage.getItem(VISITOR_KEY)
  if (!visitorId) {
    visitorId = crypto.randomUUID()
    localStorage.setItem(VISITOR_KEY, visitorId)
  }
  return visitorId
}

export const trackPageView = (pageType, activityId = null, answererId = null) => {
  const viewKey = `keyflow_viewed_${pageType}_${activityId || 'global'}_${answererId || 'anonymous'}`
  if (sessionStorage.getItem(viewKey)) return
  sessionStorage.setItem(viewKey, '1')
  supabase.rpc('keyflow_track_page_view', {
    p_page_type: pageType,
    p_activity_id: activityId,
    p_answerer_id: answererId,
    p_visitor_id: getVisitorId(),
  }).then(() => {})
}

export const trackAnswererDashboardView = (answererId) => {
  if (answererId) trackPageView('answerer_dashboard', null, answererId)
}
