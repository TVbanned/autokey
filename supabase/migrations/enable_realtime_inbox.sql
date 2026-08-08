-- Enable Realtime for keyflow_inbox so answerers see new private messages without refresh
ALTER PUBLICATION supabase_realtime ADD TABLE keyflow_inbox;
