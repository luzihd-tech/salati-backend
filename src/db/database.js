/**
 * SALATI - Couche de données
 * Connectée à Supabase (PostgreSQL hébergé).
 */

const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SECRET_KEY; // clé secrète, accès complet, usage backend uniquement

if (!supabaseUrl || !supabaseKey) {
  console.error('❌ SUPABASE_URL ou SUPABASE_SECRET_KEY manquant dans le fichier .env');
}

const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

module.exports = { supabase };
