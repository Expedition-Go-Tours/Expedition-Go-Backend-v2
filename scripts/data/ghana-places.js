'use strict';

/**
 * Commonly-searched Ghanaian cities and towns, grouped by the 16 administrative
 * regions. These are seeded into the Attraction table as `category: 'City / Town'`
 * rows so the search dropdown can autocomplete places that have no tours yet —
 * clicking one resolves the region and falls back to nearby tours.
 *
 * Keep the region names bare (no "Region" suffix) to match the Attraction table
 * convention and the REGION_PRIORITY / REGION_CAPITALS maps in the importer.
 */

const GHANA_PLACES = {
  'Greater Accra': [
    'Accra', 'Tema', 'Madina', 'Ashaiman', 'Teshie', 'Nungua', 'Adenta',
    'Dodowa', 'Prampram', 'Ada Foah', 'Kpone', 'Oyibi', 'Amasaman',
    'Abokobi', 'Kwabenya', 'Dome', 'Haatso', 'Taifa', 'Lashibi', 'Gbawe',
  ],
  Ashanti: [
    'Kumasi', 'Obuasi', 'Ejisu', 'Konongo', 'Mampong', 'Bekwai', 'Offinso',
    'Agona', 'Kumawu', 'Effiduase', 'Juaben', 'Asokwa', 'Suame', 'Tafo',
    'Ejura', 'Agogo', 'Fomena', 'Jacobu', 'Nkawie', 'Kwadaso',
  ],
  Central: [
    'Cape Coast', 'Kasoa', 'Winneba', 'Mankessim', 'Agona Swedru',
    'Dunkwa-on-Offin', 'Assin Fosu', 'Elmina', 'Saltpond', 'Apam', 'Anomabo',
    'Twifo Praso', 'Ajumako', 'Bawjiase', 'Senya Beraku', 'Komenda', 'Abura',
    'Moree', 'Nyakrom', 'Breman Asikuma',
  ],
  Eastern: [
    'Koforidua', 'Nkawkaw', 'Akosombo', 'Suhum', 'Kibi', 'Asamankese',
    'Aburi', 'Nsawam', 'Akropong', 'Somanya', 'Odumase Krobo', 'Akim Oda',
    'Kade', 'Anyinam', 'Abetifi', 'Begoro', 'Akwatia', 'Mpraeso',
    'Akim Swedru', 'Donkorkrom',
  ],
  Western: [
    'Sekondi-Takoradi', 'Sekondi', 'Takoradi', 'Tarkwa', 'Axim', 'Prestea',
    'Bogoso', 'Shama', 'Elubo', 'Dixcove', 'Busua', 'Agona Nkwanta',
    'Daboase', 'Asankragwa', 'Wassa Akropong', 'Mpohor', 'Manso Amenfi',
    'Half Assini', 'Nkroful', 'Aboso',
  ],
  Volta: [
    'Ho', 'Keta', 'Hohoe', 'Anloga', 'Kpando', 'Akatsi', 'Sogakope', 'Dzodze',
    'Adidome', 'Battor', 'Aflao', 'Denu', 'Abor', 'Vakpo', 'Golokwati',
    'Kpeve', 'Ave', 'Have', 'Amedzofe', 'Wli',
  ],
  Bono: [
    'Sunyani', 'Berekum', 'Dormaa Ahenkro', 'Wenchi', 'Nsawkaw',
    'Banda Ahenkro', 'Drobo', 'Seikwa', 'Nsoatre', 'Chiraa', 'Fiapre',
    'Atronie', 'Odumase', 'Bomaa', 'Nkrankwanta', 'Wamfie', 'Japekrom',
    'Suma Ahenkro', 'Dormaa Akwamu', 'Kwatire',
  ],
  'Bono East': [
    'Techiman', 'Kintampo', 'Nkoranza', 'Atebubu', 'Yeji', 'Prang',
    'Kwame Danso', 'Jema', 'Badu', 'Abease', 'Kajaji', 'Busunya', 'Tanoso',
    'Tuobodom', 'Offuman', 'Forikrom', 'Dromankese', 'Asueyi', 'Amantin',
    'Tanoboase',
  ],
  Ahafo: [
    'Goaso', 'Kukuom', 'Kenyasi', 'Hwidiem', 'Duayaw Nkwanta', 'Bechem',
    'Mim', 'Sankore', 'Ntotroso', 'Wamahinso', 'Akrodie', 'Ayum', 'Kwapong',
    'Gyedu', 'Biaso', 'Nkasiem', 'Tanoano', 'Subriso', 'Adrobaa', 'Asuadai',
  ],
  Northern: [
    'Tamale', 'Yendi', 'Savelugu', 'Gushegu', 'Bimbilla', 'Karaga', 'Tolon',
    'Sagnarigu', 'Nyankpala', 'Kumbungu', 'Saboba', 'Zabzugu', 'Nanton',
    'Sang', 'Pong-Tamale', 'Kpandae', 'Kpalbe', 'Wulensi', 'Diare', 'Dalun',
  ],
  Savannah: [
    'Damongo', 'Salaga', 'Bole', 'Sawla', 'Buipe', 'Daboya', 'Larabanga',
    'Mognori', 'Yapei', 'Lingbinsi', 'Kulmasa', 'Sonyo', 'Tuna', 'Kalba',
    'Busunu', 'Mempeasem', 'Fufulso', 'Kpembe', 'Chama', 'Jentilpe',
  ],
  'North East': [
    'Nalerigu', 'Gambaga', 'Walewale', 'Bunkpurugu', 'Chereponi', 'Yunyoo',
    'Nakpanduri', 'Yagaba', 'Langbinsi', 'Wulugu', 'Kpasenkpe', 'Janga',
    'Sakogu', 'Soo', 'Zua', 'Gbintiri', 'Nasia', 'Wungu', 'Loagri',
    'Kpatorigu',
  ],
  'Upper East': [
    'Bolgatanga', 'Navrongo', 'Bawku', 'Zebilla', 'Bongo', 'Sandema', 'Paga',
    'Chiana', 'Kandiga', 'Sirigu', 'Tongo', 'Pusiga', 'Garu', 'Binduri',
    'Fumbisi', 'Wiaga', 'Zuarungu', 'Winkogo', 'Sumbrungu', 'Binaba',
  ],
  'Upper West': [
    'Wa', 'Lawra', 'Nandom', 'Tumu', 'Jirapa', 'Hamile', 'Funsi', 'Gwollu',
    'Wechiau', 'Nadowli', 'Kaleo', 'Daffiama', 'Issa', 'Babile', 'Dorimon',
    'Lambussie', 'Kundungu', 'Loggu', 'Charia', 'Piina',
  ],
  Oti: [
    'Dambai', 'Jasikan', 'Kadjebi', 'Nkwanta', 'Kete-Krachi', 'Chinderi',
    'Kpassa', 'Worawora', 'Nkonya Ahenkro', 'Apesokubi', 'Bowiri', 'Shiare',
    'Kwamikrom', 'Brekumanso', 'Likpe', 'Tutukpene', 'Ekumdipe', 'Guaman',
    'Kyirakrom', 'Ahamansu',
  ],
  'Western North': [
    'Sefwi Wiawso', 'Bibiani', 'Sefwi Bekwai', 'Sefwi Anhwiaso', 'Juaboso',
    'Enchi', 'Dadieso', 'Akontombra', 'Bodi', 'Adabokrom', 'Chirano', 'Awaso',
    'Debiso', 'Essam', 'Asawinso', 'Nsawora', 'Sefwi Asempanaye',
    'Oseikojokrom', 'Datano', 'Sui',
  ],
};

const REGION_CAPITALS = {
  'Greater Accra': 'Accra',
  Ashanti: 'Kumasi',
  Central: 'Cape Coast',
  Eastern: 'Koforidua',
  Western: 'Sekondi-Takoradi',
  Volta: 'Ho',
  Bono: 'Sunyani',
  'Bono East': 'Techiman',
  Ahafo: 'Goaso',
  Northern: 'Tamale',
  Savannah: 'Damongo',
  'North East': 'Nalerigu',
  'Upper East': 'Bolgatanga',
  'Upper West': 'Wa',
  Oti: 'Dambai',
  'Western North': 'Sefwi Wiawso',
};

const REGION_PRIORITY = {
  'Greater Accra': 'Very High',
  Ashanti: 'High',
  Central: 'High',
  Western: 'Medium',
  Eastern: 'Medium',
  Volta: 'Medium',
  Bono: 'Medium',
  'Bono East': 'Medium',
  Northern: 'Medium',
  Oti: 'Medium',
  Ahafo: 'Standard',
  Savannah: 'Standard',
  'North East': 'Standard',
  'Upper East': 'Standard',
  'Upper West': 'Standard',
  'Western North': 'Standard',
};

module.exports = { GHANA_PLACES, REGION_CAPITALS, REGION_PRIORITY };
