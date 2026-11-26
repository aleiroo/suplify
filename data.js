// Nilai gizi/yield/harga di katalog ini adalah data DEMO/APROKSIMASI.
// Ganti dengan data TKPI resmi dan harga pasar terverifikasi sebelum penggunaan produksi.
const C = (id, name, alias, y, n, ref) => ({ id, name, alias, yield: y, n, ref });
const CATALOG = [
 C('beras','Beras','nasi beras',1,[357,8.4,1.7,77.1],14000),
 C('ayam','Daging ayam','ayam dada paha',0.65,[298,18.2,25,0],38000),
 C('telur','Telur ayam','telur bebek',0.88,[154,12.4,10.8,0.7],28000),
 C('tempe','Tempe','kedelai',1,[201,20.8,8.8,13.5],14000),
 C('tahu','Tahu putih','tahu kuning',1,[80,10.9,4.7,0.8],12000),
 C('bawang_merah','Bawang merah','shallot',0.94,[39,1.5,0.3,9.2],40000),
 C('bawang_putih','Bawang putih','garlic',0.85,[95,4.5,0.2,23.1],38000),
 C('cabai','Cabai merah','cabe cabai rawit',0.85,[36,1,0.3,7.8],55000),
 C('minyak','Minyak goreng','minyak sawit',1,[884,0,100,0],18000),
 C('wortel','Wortel','sayur wortel',0.88,[36,1,0.6,7.9],12000),
 C('kol','Kol','kubis',0.8,[25,1.7,0.2,5.3],9000),
 C('bayam','Bayam','sayur',0.7,[36,3.5,0.5,6.5],10000),
 C('lele','Ikan lele','lele',0.7,[113,17.7,4.4,0],30000),
 C('sapi','Daging sapi','sapi',0.85,[201,18.8,14,0],140000),
 C('kentang','Kentang','ubi kentang',0.85,[87,1.9,0.1,20.1],16000),
 C('tomat','Tomat','buah tomat',0.95,[20,1,0.2,4.2],14000),
 C('udang','Udang','udang segar',0.65,[91,21,0.2,0.1],85000)
];
const FALLBACK = {
 'nasi goreng': [['beras',60],['ayam',40],['telur',30],['bawang_merah',15],['bawang_putih',5],['cabai',10],['minyak',10]],
 'soto ayam': [['ayam',60],['beras',60],['wortel',20],['kol',20],['bawang_putih',5],['bawang_merah',10],['telur',20]],
 'pecel lele': [['lele',120],['beras',60],['cabai',15],['kol',30],['tempe',30],['minyak',15]],
 'ayam goreng': [['ayam',120],['bawang_putih',5],['bawang_merah',10],['minyak',15]],
 'gado gado': [['tahu',50],['tempe',40],['telur',40],['kol',30],['wortel',30]],
};
module.exports = { CATALOG, FALLBACK };
