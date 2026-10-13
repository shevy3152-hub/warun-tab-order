import { customerThemePlacementFrames } from './customer-theme-display-condition.js';
const number = (value) => Number.isFinite(value) ? value.toFixed(1) : '計測待ち';
const coordinates = (rect) => `左${number(rect.left)}・上${number(rect.top)}・右${number(rect.right)}・下${number(rect.bottom)}画像px`;

export function customerThemeGenerationImageInstruction(definition, prompt = '') {
  // Preserve the stored legacy seed; only replace its wording in the generated copy.
  if (definition.id === 'japanese-halloween' && prompt.trim() === definition.prompt.trim()) {
    return '生成り和紙の背景に、アンティーク書体の装飾用タイトル「Happy」「Halloween」の2段表記と、かぼちゃの山車・猫・紅葉などを描いてください。和風の季節感と温かい橙・茶系の色を使い、主役の輪郭とタイトルが読み取れる構図にしてください。';
  }
  return prompt.trim() || '絵柄・背景・色・書体などの好みを別途指定します。';
}

export function buildCustomerThemeGenerationPrompt({ definition, variant, measurement }) {
  if (!definition?.assetPath || !definition.image) return '';
  const { width, height } = definition.image;
  const format = definition.assetPath.split('.').pop().toUpperCase();
  const lines = [
    `【共通ベースプロンプト：${definition.label}】`,
    `${format}形式、横${width}×縦${height}画像px、横：縦＝${width}：${height}（約${(width / height).toFixed(3)}：1）の背景画像を生成してください。縦横比を保ち、指定寸法のキャンバス全体を制作してください。`,
    '以下の座標は元画像の左上を原点とする画像pxです。選択した表示条件の参考値です。実客席では画面サイズや表示内容により変わります。全画面サイズでの安全領域を保証するものではありません。',
  ];
  if (!measurement) {
    lines.push('表示範囲・UI重なり座標・適用条件は計測待ちです。未測定の座標を推測しないでください。');
  } else if (measurement.imageHidden) {
    lines.push('現在のプレビューでは画像が非表示です。表示範囲・UI重なり座標は使用できません。展開して測定した参考値を使ってください。');
  } else {
    const mode = !Number.isFinite(measurement.zoom) ? '計測待ち' : Math.abs(measurement.zoom - measurement.minimumZoom) < 0.00001 ? '画像全体を表示' : Math.abs(measurement.zoom - 1) < 0.00001 ? '枠いっぱいに表示' : measurement.zoom < 1 ? '縮小調整' : '拡大調整';
    lines.push(`【座標の適用条件】表示方法：${mode}。枠${measurement.frameWidth ?? '計測待ち'}×${measurement.frameHeight ?? '計測待ち'} CSS px、倍率${measurement.zoom?.toFixed(4) ?? '計測待ち'}×（枠いっぱい＝1.00）、X${number(measurement.positionX * 100)}%・Y${number(measurement.positionY * 100)}%。カテゴリ${measurement.categoryCount}件＋空き行${measurement.placeholderCount}件。${measurement.conditionLabel ?? "現在の管理画面条件"} viewport ${measurement.viewportWidth}×${measurement.viewportHeight} CSS px、DPR ${measurement.dpr}（実測情報のみ。画像座標の倍率に掛けない）。`);
    const visible = measurement.visibleImage;
    lines.push(visible?.status === 'overlap' ? `【現在画像が表示される範囲】${coordinates(visible)}。重要な文字・主役の輪郭全体を、この表示範囲の端から余裕を取って配置してください。` : visible?.status === 'none' ? '現在、クリップ枠内に画像の表示部分がありません。表示範囲を推測しないでください。' : '画像の表示範囲は計測待ちです。座標を推測しないでください。');
    if (visible?.status === 'overlap') lines.push(`現在の切り抜き量：左${number(visible.left)}・上${number(visible.top)}・右${number(width - visible.right)}・下${number(height - visible.bottom)}画像px。`);
    lines.push(`枠側の余白合計：横${number(measurement.spaceX)}・縦${number(measurement.spaceY)} CSS px。移動範囲：横${number(measurement.rangeX)}・縦${number(measurement.rangeY)} CSS px。これらは表示枠側の値で、元画像内に描く余白の寸法ではありません。`);
    lines.push('【UIが重なる領域】以下の領域は、重要な文字や主役の配置を極力避けてください。背景模様や脇役の一部が重なることは許容します。UIの文字が読みやすいよう、該当領域は描き込みや強いコントラストを抑えてください。');
    for (const region of measurement.regions) lines.push(`${region.label}：${region.status === 'overlap' ? coordinates(region) : region.status === 'none' ? '現在の画像との交差なし' : region.status === 'hidden' ? '現在は非表示・座標なし' : '計測待ち・座標なし'}。`);
    lines.push('カテゴリ領域にはボタン上側の余白も含まれます。案内ボタンなど現在非表示の要素について、将来の表示位置や座標を仮定しないでください。');
  }
  const frames = customerThemePlacementFrames(measurement, definition.image);
  lines.push('【重要要素の配置枠】以下は表示範囲の内側に余裕を取り、実測UIを避けた制作案です。枠の左上・右下は元画像px。');
  for (const [key, label] of [['title', 'タイトル：文字全体'], ['subject', '主役：輪郭全体']]) {
    lines.push(frames[key] ? label + 'の配置枠：' + coordinates(frames[key]) + '。' : label + 'の配置枠：成立する空き領域を確認できないため未設定。無理な数値を作らず構図を検討してください。');
  }
  lines.push(frames.reason);
  if (measurement?.limitations) lines.push('再現の限界：' + measurement.limitations);
  lines.push('背景は四辺まで自然につながるよう描き、重要要素を表示範囲の内側へ余裕を取って置いてください。タイトルの文字全体を枠の中心へ水平中央揃えし、装飾・影・筆の払いも枠内へ収めてください。主役の幅は配置枠の80〜85%程度を目安にし、耳・ひげ・しっぽ・車輪・添え物まで輪郭全体を枠内へ収め、周囲に調整用の背景を残してください。参考画像は画風・素材感の参考とし、構図・文字位置は今回の配置指示を優先してください。構図を生成時に整え、編集画面では微調整します。画像全体の縮小で画像外の上下余白が増える場合があります。スライダーの設定範囲は見た目が成立する範囲ではなく、未確認範囲の安全を保証しません。');
  lines.push(
    '【切り抜き・移動に配慮した構図】重要な文字・主役を画像や表示範囲の端へ寄せすぎず、輪郭全体の周囲に余裕を設けてください。画像の移動・拡大や画面の縦横比変更で切り抜かれる可能性を考慮し、背景模様は周辺まで自然につながる構図にしてください。「画像全体を表示」は余白ができる場合があり、「枠いっぱいに表示」は上下または左右が切り抜かれる場合があります。枠側の余白はアプリの背景色で埋まり、画像の一部ではありません。',
    '店名・カテゴリ名・営業時間・ラストオーダーなど、アプリが重ねるUI文字やボタン・区切り線を画像へ描き込まないでください。希望する装飾用タイトルは別扱いとし、指定した場合だけ描いてください。',
    '【季節固有のイメージ指示】以下は新しく生成する画像への希望であり、現在の画像の確定仕様を説明するものではありません。',
    customerThemeGenerationImageInstruction(definition, variant?.prompt),
  );
  return lines.join('\n\n');
}
