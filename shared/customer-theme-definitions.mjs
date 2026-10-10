export const CUSTOMER_THEME_DEFINITIONS = Object.freeze({
  standard: Object.freeze({ id: 'standard', label: '標準（赤レール）', assetPath: null, available: true, prompt: '画像は使用しない標準の赤レール。文字やロゴを画像に描かず、UIが重なる領域に重要な絵柄を置かない。', notes: '未設定・画像読込失敗時のfallback。客席レールは従来の赤表示。' }),
  camellia: Object.freeze({ id: 'camellia', label: '椿（camellia）', assetPath: '/customer-rail-washi-camellia-accepted.png', image: Object.freeze({ width: 426, height: 1587 }), available: true, prompt: '和紙に描いた椿の縦長模様。文字・ロゴを画像に描かない。UIが重なる領域に重要な絵柄を置かない。客席端末の展開時レールに使う背景素材。', notes: '実画像 426×1587 px（約0.268:1）。画像の縦横比を保ちます。「画像全体を表示」では全体が収まる倍率で中央に配置し、余白はテーマの背景色で埋めます。「枠いっぱいに表示」では表示枠を埋めるため、画面の形や倍率によって上下または左右が切り抜かれる場合があります。画像が枠より大きい方向は切り抜き範囲、小さい方向は余白範囲で移動できます。枠に一致する方向は移動範囲0です。X・Yとも50%が中央です。表示枠の寸法は画面サイズで変わるため、切り抜き・余白・移動範囲も変わります。椿の主役と文字・ボタンの重なりをプレビューで確認してください。' }),
  'autumn-leaves': Object.freeze({ id: 'autumn-leaves', label: '紅葉', assetPath: '/customer-rail-washi-autumn-leaves.png', image: Object.freeze({ width: 1008, height: 1561 }), initialPositionX: 1, available: true, prompt: '和紙に描いた紅葉の縦長背景。文字・ロゴなし。葉の主役と枝を店名、カテゴリ、営業時間のガイド領域に重ねすぎない構図。', notes: '実画像 1008×1561 px（約0.646:1）。画像の縦横比を保ちます。「画像全体を表示」では全体が収まる倍率で中央に配置し、余白はテーマの背景色で埋めます。「枠いっぱいに表示」では表示枠を埋めるため、画面の形や倍率によって上下または左右が切り抜かれる場合があります。初期位置は右寄せです。画像が枠より大きい方向は切り抜き範囲、小さい方向は余白範囲で移動できます。枠に一致する方向は移動範囲0です。X・Yとも50%が中央です。表示枠の寸法は画面サイズで変わるため、切り抜き・余白・移動範囲も変わります。葉の主役と店名・カテゴリ・営業時間・アイコンの重なりをプレビューで確認してください。' }),
  'moon-susuki': Object.freeze({ id: 'moon-susuki', label: '月とすすき', assetPath: '/customer-rail-washi-moon-susuki.png', image: Object.freeze({ width: 1007, height: 1561 }), initialPositionX: 1, available: true, prompt: '和紙に描いた月とすすきの縦長背景。文字・ロゴなし。月の輪郭とすすきの穂先を店名、カテゴリ、営業時間のガイド領域から外せる構図。', notes: '実画像 1007×1561 px（約0.645:1）。画像の縦横比を保ちます。「画像全体を表示」では全体が収まる倍率で中央に配置し、余白はテーマの背景色で埋めます。「枠いっぱいに表示」では表示枠を埋めるため、画面の形や倍率によって上下または左右が切り抜かれる場合があります。初期位置は右寄せで月を表示します。画像が枠より大きい方向は切り抜き範囲、小さい方向は余白範囲で移動できます。枠に一致する方向は移動範囲0です。X・Yとも50%が中央です。表示枠の寸法は画面サイズで変わるため、切り抜き・余白・移動範囲も変わります。月やすすきと店名・カテゴリ・営業時間・アイコンの重なりをプレビューで確認してください。' }),
  'japanese-halloween': Object.freeze({ id: 'japanese-halloween', label: '和風ハロウィン', assetPath: '/customer-rail-washi-japanese-halloween.png', image: Object.freeze({ width: 803, height: 1958 }), available: true, railPalette: Object.freeze({ background: '#f3eadb', foreground: '#482c1d', separator: 'rgb(72 44 29 / 56%)', selectedBackground: '#fff5e4', selectedForeground: '#4c2617', selectedMarkerBackground: '#4c2617', selectedMarkerForeground: '#fff8ec', focus: '#28150d' }), prompt: '生成り和紙にポップな橙色のHALLOWEEN文字と、下部中央の大きなかぼちゃの山車・猫・紅葉を描く縦長背景。主役は下部にまとめ、レールの文字や操作領域を避ける。', notes: '実画像803×1958px（横：縦 約0.410：1）。生成り和紙の背景に、上部のタイトルと下部のかぼちゃなどを配置しています。\n画像の縦横比は保たれます。「画像全体を表示」では画像全体が収まる倍率で中央に配置し、余白はテーマの背景色で埋めます。「枠いっぱいに表示」ではレールを埋めるため、画面の形によって上下または左右が切り抜かれます。\n画像が枠より大きい方向は切り抜き範囲内、小さい方向は余白の範囲内で移動できます。枠にぴったり一致する方向は移動範囲がありません。X・Yとも50%が中央です。\n画面サイズとズームによって、切り抜き量・余白・移動範囲が変わります。タイトルや主役は画像の端から余裕を持って配置し、店名・カテゴリ・営業時間・アイコンとの重なりをプレビューで確認してください。' }),
});

export const CUSTOMER_THEME_KEYS = Object.freeze(Object.fromEntries(
  Object.keys(CUSTOMER_THEME_DEFINITIONS).map((key) => [key, key]),
));

export function isSupportedCustomerTheme(theme) {
  return Object.hasOwn(CUSTOMER_THEME_DEFINITIONS, theme);
}

export function isAvailableCustomerTheme(theme) {
  return CUSTOMER_THEME_DEFINITIONS[theme]?.available === true;
}
