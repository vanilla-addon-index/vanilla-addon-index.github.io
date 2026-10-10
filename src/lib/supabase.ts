import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from './config';

export const configured = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export const supabase = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;
