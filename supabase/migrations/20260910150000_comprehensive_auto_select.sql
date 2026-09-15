-- 综合活动无需筛选：报名即入选
update public.keyflow_applications a
set status = 'selected'
from public.keyflow_activities g
where a.activity_id = g.id
  and g.activity_type = 'comprehensive'
  and a.status in ('pending', 'rejected');
