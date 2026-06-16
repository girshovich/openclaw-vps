import { randomUUID } from 'node:crypto';
import type { RecommenderDb } from './db.js';

interface SeedTrope {
  canonical_id: string;
  label_ru: string;
  label_en: string;
  aliases: string[];
  category: string;
}

// ~30 child-relevant tropes (spec §3.6 / implement-skills-movie.md Phase 1).
const TROPES: SeedTrope[] = [
  { canonical_id: 'trope:underdog_hero', label_ru: 'неудачник становится героем', label_en: 'underdog becomes hero', aliases: ['из неудачника в герои', 'zero to hero'], category: 'growth' },
  { canonical_id: 'trope:wise_mentor', label_ru: 'мудрый наставник', label_en: 'wise mentor', aliases: ['учитель-наставник', 'mentor figure'], category: 'relationships' },
  { canonical_id: 'trope:lost_finding_way_home', label_ru: 'потерялся и нашёл дорогу домой', label_en: 'lost and finding the way home', aliases: ['путь домой', 'finding the way back'], category: 'journey' },
  { canonical_id: 'trope:found_family', label_ru: 'обретённая семья', label_en: 'found family', aliases: ['чужие становятся семьёй'], category: 'relationships' },
  { canonical_id: 'trope:chosen_one', label_ru: 'избранный', label_en: 'chosen one', aliases: ['пророчество об избранном'], category: 'growth' },
  { canonical_id: 'trope:unlikely_friendship', label_ru: 'дружба противоположностей', label_en: 'unlikely friendship', aliases: ['неожиданная дружба'], category: 'relationships' },
  { canonical_id: 'trope:coming_of_age', label_ru: 'повзросление', label_en: 'coming of age', aliases: ['взросление героя'], category: 'growth' },
  { canonical_id: 'trope:overcoming_fear', label_ru: 'преодоление страха', label_en: 'overcoming fear', aliases: ['победа над страхом'], category: 'growth' },
  { canonical_id: 'trope:sibling_rivalry', label_ru: 'соперничество братьев и сестёр', label_en: 'sibling rivalry', aliases: ['ссоры братьев и сестёр'], category: 'relationships' },
  { canonical_id: 'trope:talking_animal_companion', label_ru: 'говорящий зверь-компаньон', label_en: 'talking animal companion', aliases: ['животное-помощник, который говорит'], category: 'companions' },
  { canonical_id: 'trope:magical_transformation', label_ru: 'волшебное превращение', label_en: 'magical transformation', aliases: ['превращение с помощью магии'], category: 'magic' },
  { canonical_id: 'trope:good_vs_evil', label_ru: 'добро против зла', label_en: 'good versus evil', aliases: ['классическое противостояние добра и зла'], category: 'conflict' },
  { canonical_id: 'trope:secret_identity', label_ru: 'секретная личность', label_en: 'secret identity', aliases: ['тайная личность героя'], category: 'conflict' },
  { canonical_id: 'trope:quest_for_treasure', label_ru: 'поиск сокровища', label_en: 'quest for treasure', aliases: ['охота за сокровищем'], category: 'journey' },
  { canonical_id: 'trope:parent_separation', label_ru: 'разлука с родителями', label_en: 'parent separation', aliases: ['потеря родителей', 'separation from parents'], category: 'sensitive' },
  { canonical_id: 'trope:reluctant_hero', label_ru: 'герой против своей воли', label_en: 'reluctant hero', aliases: ['неохотный герой'], category: 'growth' },
  { canonical_id: 'trope:team_up', label_ru: 'объединение команды', label_en: 'team-up', aliases: ['сбор команды героев'], category: 'relationships' },
  { canonical_id: 'trope:tournament_arc', label_ru: 'турнирная арка', label_en: 'tournament arc', aliases: ['соревнование/турнир'], category: 'conflict' },
  { canonical_id: 'trope:underestimated_sidekick', label_ru: 'недооценённый помощник', label_en: 'underestimated sidekick', aliases: ['помощник, которого недооценивали'], category: 'companions' },
  { canonical_id: 'trope:redemption_arc', label_ru: 'искупление', label_en: 'redemption arc', aliases: ['арка искупления злодея'], category: 'growth' },
  { canonical_id: 'trope:monster_of_the_week', label_ru: 'монстр недели', label_en: 'monster of the week', aliases: ['новый монстр каждую серию'], category: 'conflict' },
  { canonical_id: 'trope:friendship_overcomes_all', label_ru: 'дружба превыше всего', label_en: 'friendship overcomes all', aliases: ['сила дружбы'], category: 'relationships' },
  { canonical_id: 'trope:time_travel', label_ru: 'путешествие во времени', label_en: 'time travel', aliases: ['перемещение во времени'], category: 'magic' },
  { canonical_id: 'trope:hidden_world', label_ru: 'скрытый мир', label_en: 'hidden world', aliases: ['тайный параллельный мир'], category: 'journey' },
  { canonical_id: 'trope:animal_sidekick_saves_day', label_ru: 'питомец спасает положение', label_en: 'animal sidekick saves the day', aliases: ['зверь-компаньон спасает героя'], category: 'companions' },
  { canonical_id: 'trope:royal_secret', label_ru: 'королевская тайна', label_en: 'royal secret', aliases: ['тайна королевской семьи'], category: 'conflict' },
  { canonical_id: 'trope:training_montage', label_ru: 'тренировочный монтаж', label_en: 'training montage', aliases: ['монтаж тренировок героя'], category: 'growth' },
  { canonical_id: 'trope:villain_seeks_power', label_ru: 'злодей жаждет власти', label_en: 'villain seeks power', aliases: ['злодей хочет власти/контроля'], category: 'conflict' },
  { canonical_id: 'trope:comedic_relief_duo', label_ru: 'комедийный дуэт', label_en: 'comedic relief duo', aliases: ['смешная парочка персонажей'], category: 'tone' },
  { canonical_id: 'trope:self_acceptance', label_ru: 'принятие себя', label_en: 'self-acceptance', aliases: ['герой принимает себя таким, какой он есть'], category: 'growth' },
];

interface SeedTaxonomyEntry {
  source: 'tmdb' | 'jikan';
  source_term: string;
  canonical_value: string;
}

// TMDB & Jikan genre/tag terms collapsed into one canonical taxonomy (spec §3.6 note).
const TAXONOMY: SeedTaxonomyEntry[] = [
  { source: 'tmdb', source_term: 'Animation', canonical_value: 'genre:animation' },
  { source: 'tmdb', source_term: 'Adventure', canonical_value: 'genre:adventure' },
  { source: 'tmdb', source_term: 'Family', canonical_value: 'genre:family' },
  { source: 'tmdb', source_term: 'Fantasy', canonical_value: 'genre:fantasy' },
  { source: 'tmdb', source_term: 'Comedy', canonical_value: 'genre:comedy' },
  { source: 'tmdb', source_term: 'Action', canonical_value: 'genre:action' },
  { source: 'tmdb', source_term: 'Drama', canonical_value: 'genre:drama' },
  { source: 'tmdb', source_term: 'Science Fiction', canonical_value: 'genre:scifi' },
  { source: 'tmdb', source_term: 'Mystery', canonical_value: 'genre:mystery' },
  { source: 'tmdb', source_term: 'Romance', canonical_value: 'genre:romance' },
  { source: 'tmdb', source_term: 'Music', canonical_value: 'genre:music' },
  { source: 'tmdb', source_term: 'Crime', canonical_value: 'genre:crime' },
  { source: 'tmdb', source_term: 'Horror', canonical_value: 'genre:horror' },
  { source: 'tmdb', source_term: 'Thriller', canonical_value: 'genre:thriller' },
  { source: 'tmdb', source_term: 'War', canonical_value: 'genre:war' },
  { source: 'tmdb', source_term: 'Western', canonical_value: 'genre:western' },
  { source: 'tmdb', source_term: 'History', canonical_value: 'genre:history' },
  { source: 'tmdb', source_term: 'Documentary', canonical_value: 'genre:documentary' },
  { source: 'jikan', source_term: 'Action', canonical_value: 'genre:action' },
  { source: 'jikan', source_term: 'Adventure', canonical_value: 'genre:adventure' },
  { source: 'jikan', source_term: 'Comedy', canonical_value: 'genre:comedy' },
  { source: 'jikan', source_term: 'Drama', canonical_value: 'genre:drama' },
  { source: 'jikan', source_term: 'Fantasy', canonical_value: 'genre:fantasy' },
  { source: 'jikan', source_term: 'Horror', canonical_value: 'genre:horror' },
  { source: 'jikan', source_term: 'Mystery', canonical_value: 'genre:mystery' },
  { source: 'jikan', source_term: 'Romance', canonical_value: 'genre:romance' },
  { source: 'jikan', source_term: 'Sci-Fi', canonical_value: 'genre:scifi' },
  { source: 'jikan', source_term: 'Slice of Life', canonical_value: 'theme:slice_of_life' },
  { source: 'jikan', source_term: 'Sports', canonical_value: 'theme:sports' },
  { source: 'jikan', source_term: 'Supernatural', canonical_value: 'theme:supernatural' },
  { source: 'jikan', source_term: 'Kids', canonical_value: 'genre:family' },
  { source: 'jikan', source_term: 'Mecha', canonical_value: 'genre:mecha' },
  { source: 'jikan', source_term: 'Music', canonical_value: 'genre:music' },
  { source: 'jikan', source_term: 'School', canonical_value: 'theme:school' },
  { source: 'jikan', source_term: 'Magic', canonical_value: 'theme:magic' },
  { source: 'jikan', source_term: 'Historical', canonical_value: 'genre:history' },
  { source: 'jikan', source_term: 'Military', canonical_value: 'theme:military' },
  { source: 'jikan', source_term: 'Psychological', canonical_value: 'genre:psychological' },
  { source: 'jikan', source_term: 'Space', canonical_value: 'theme:space' },
  { source: 'jikan', source_term: 'Super Power', canonical_value: 'theme:super_power' },
];

export function seedRecommenderDb(db: RecommenderDb): void {
  const insertTrope = db.prepare(`
    INSERT INTO trope_dictionary (id, canonical_id, label_ru, label_en, aliases, category)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(canonical_id) DO NOTHING
  `);
  for (const t of TROPES) {
    insertTrope.run(randomUUID(), t.canonical_id, t.label_ru, t.label_en, JSON.stringify(t.aliases), t.category);
  }

  const insertTaxonomy = db.prepare(`
    INSERT INTO taxonomy_map (source, source_term, canonical_value)
    VALUES (?, ?, ?)
    ON CONFLICT(source, source_term) DO NOTHING
  `);
  for (const m of TAXONOMY) {
    insertTaxonomy.run(m.source, m.source_term, m.canonical_value);
  }
}
