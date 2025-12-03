// sanityCheck.js – enkel database-sjekk for Grenseløs Reise

import dotenv from 'dotenv';
import pkg from 'pg';

dotenv.config();
const { Pool } = pkg;

// Juster hvis du bruker andre env-variabler på Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || undefined,
  host: process.env.DB_HOST || undefined,
  port: process.env.DB_PORT ? Number(process.env.DB_PORT) : undefined,
  user: process.env.DB_USER || undefined,
  password: process.env.DB_PASSWORD || undefined,
  database: process.env.DB_NAME || undefined
});

async function run() {
  console.log('🔎 Starter sanity check av trips-tabellen …\n');

  // 1) Antall trips + hvor mange som har galleri
  const counts = await pool.query(`
    SELECT
      COUNT(*) AS total_trips,
      COUNT(*) FILTER (WHERE gallery IS NOT NULL AND gallery::text <> '[]') AS trips_with_gallery,
      COUNT(*) FILTER (WHERE jsonb_typeof(stops) = 'array') AS trips_with_stops_array,
      COUNT(*) FILTER (WHERE jsonb_typeof(packing_list) = 'array') AS trips_with_packing_array,
      COUNT(*) FILTER (WHERE jsonb_typeof(hotels) = 'array') AS trips_with_hotels_array
    FROM trips;
  `);

  console.log('📊 Oversikt:');
  console.table(counts.rows);

  // 2) Sjekk at gallery er array
  const badGalleryType = await pool.query(`
    SELECT id, title, gallery
    FROM trips
    WHERE gallery IS NOT NULL
      AND jsonb_typeof(gallery) <> 'array'
    LIMIT 20;
  `);

  if (badGalleryType.rows.length) {
    console.log('\n⚠️ trips der gallery IKKE er en array:');
    console.table(
      badGalleryType.rows.map(r => ({
        id: r.id,
        title: r.title,
        gallery_type: typeof r.gallery,
        gallery_json_type: (r.gallery && r.gallery.constructor && r.gallery.constructor.name) || 'unknown'
      }))
    );
  } else {
    console.log('\n✅ Alle gallery-felt ser ut til å være JSON-array.');
  }

  // 3) Elementer i gallery uten url / tom url
  const missingUrl = await pool.query(`
    SELECT
      t.id,
      t.title,
      elem AS gallery_item
    FROM trips t,
         jsonb_array_elements(t.gallery) AS elem
    WHERE
      t.gallery IS NOT NULL
      AND (
        NOT (elem ? 'url')
        OR elem->>'url' IS NULL
        OR elem->>'url' = ''
      )
    LIMIT 50;
  `);

  if (missingUrl.rows.length) {
    console.log('\n⚠️ Galleri-elementer uten url / tom url:');
    missingUrl.rows.forEach((row, idx) => {
      console.log(`\n[${idx + 1}] Trip ${row.id} – ${row.title}`);
      console.dir(row.gallery_item, { depth: null });
    });
  } else {
    console.log('\n✅ Ingen galleri-elementer med manglende eller tom url.');
  }

  // 4) URL-er som ikke starter med /uploads eller http(s)
  const weirdUrls = await pool.query(`
    SELECT
      t.id,
      t.title,
      elem->>'url' AS url
    FROM trips t,
         jsonb_array_elements(t.gallery) AS elem
    WHERE
      t.gallery IS NOT NULL
      AND elem ? 'url'
      AND (elem->>'url') !~ '^(https?://|/uploads/)'
    LIMIT 50;
  `);

  if (weirdUrls.rows.length) {
    console.log('\n⚠️ Galleri-URL-er som ikke starter med /uploads/ eller http(s):');
    console.table(weirdUrls.rows);
  } else {
    console.log('\n✅ Alle galleri-URL-er starter med /uploads/ eller http/https.');
  }

  // 5) Sjekk noen trips med gallery for hånd (preview)
  const sampleTrips = await pool.query(`
    SELECT
      id,
      title,
      source_type,
      source_episode_id,
      jsonb_array_length(gallery) AS gallery_len
    FROM trips
    WHERE gallery IS NOT NULL AND gallery::text <> '[]'
    ORDER BY created_at DESC
    LIMIT 15;
  `);

  console.log('\n🖼 Eksempel-trips med galleri (siste 15):');
  console.table(sampleTrips.rows);

  // 6) Sjekk at stops/packing_list/hotels faktisk er arrays
  const badStops = await pool.query(`
    SELECT id, title, jsonb_typeof(stops) AS stops_type
    FROM trips
    WHERE stops IS NOT NULL AND jsonb_typeof(stops) <> 'array'
    LIMIT 20;
  `);

  if (badStops.rows.length) {
    console.log('\n⚠️ trips der stops IKKE er en array:');
    console.table(badStops.rows);
  } else {
    console.log('\n✅ Alle stops-felt er JSON-array (eller NULL).');
  }

  const badPacking = await pool.query(`
    SELECT id, title, jsonb_typeof(packing_list) AS packing_type
    FROM trips
    WHERE packing_list IS NOT NULL AND jsonb_typeof(packing_list) <> 'array'
    LIMIT 20;
  `);

  if (badPacking.rows.length) {
    console.log('\n⚠️ trips der packing_list IKKE er en array:');
    console.table(badPacking.rows);
  } else {
    console.log('\n✅ Alle packing_list-felt er JSON-array (eller NULL).');
  }

  const badHotels = await pool.query(`
    SELECT id, title, jsonb_typeof(hotels) AS hotels_type
    FROM trips
    WHERE hotels IS NOT NULL AND jsonb_typeof(hotels) <> 'array'
    LIMIT 20;
  `);

  if (badHotels.rows.length) {
    console.log('\n⚠️ trips der hotels IKKE er en array:');
    console.table(badHotels.rows);
  } else {
    console.log('\n✅ Alle hotels-felt er JSON-array (eller NULL).');
  }

  console.log('\n🎉 Sanity check ferdig.\n');
}

run()
  .catch((err) => {
    console.error('❌ Sanity check feilet:', err);
  })
  .finally(() => {
    pool.end();
  });
