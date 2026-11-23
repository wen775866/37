import assert from 'node:assert/strict';
import {
  YansanCard,
  parseYansanCombo,
  canBeatYansanCombo,
  getYansanSmartAIPlay,
  isYansanComboDeductivelyUnbeatable,
  calculateYansanSettlement,
} from '../src/engine/yansanRules.ts';
import {
  SSSCard,
  detectSpecialHand,
  isFoulHand,
  compareTwoPlayers,
} from '../src/engine/shisanshuiRules.ts';
import {
  MahjongTile,
  checkMahjongWin,
  computeMahjongSettlement,
} from '../src/engine/mahjongRules.ts';
import {
  calculateNext0600Countdown,
  getToday0600CycleInfo,
} from '../src/engine/shisanshuiBookingTrain.ts';

function yCard(rank: number, suit: '♠' | '♥' | '♣' | '♦'): YansanCard {
  const suitVal = suit === '♠' ? 4 : suit === '♥' ? 3 : suit === '♣' ? 2 : 1;
  const label = rank === 15 ? '2' : rank === 14 ? 'A' : rank === 13 ? 'K' : rank === 12 ? 'Q' : rank === 11 ? 'J' : String(rank);
  return {
    id: `${label}-${suit}`,
    rank,
    suitVal,
    label,
    suit,
    isRed: suit === '♥' || suit === '♦',
  };
}

function sCard(rank: number, suit: '♠' | '♥' | '♣' | '♦', tag = ''): SSSCard {
  const suitVal = suit === '♠' ? 4 : suit === '♥' ? 3 : suit === '♣' ? 2 : 1;
  const label = rank === 14 ? 'A' : rank === 13 ? 'K' : rank === 12 ? 'Q' : rank === 11 ? 'J' : String(rank);
  return {
    id: `${label}-${suit}${tag}`,
    rank,
    suitVal,
    suit,
    label,
    isRed: suit === '♥' || suit === '♦',
  };
}

function mjTile(type: 'wan' | 'tiao' | 'tong' | 'zi', value: number, idSuffix: string): MahjongTile {
  const cn = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const unit = type === 'wan' ? '万' : type === 'tiao' ? '条' : type === 'tong' ? '筒' : '';
  const text = type === 'zi' ? (value === 5 ? '红中' : '东风') : `${cn[value]}${unit}`;
  return {
    id: `${type}-${value}-${idSuffix}`,
    type,
    value,
    text,
    isRedDragon: type === 'zi' && value === 5,
  };
}

function runYansanTests() {
  // 1. Canonical ID & rank weight ordering (3 > 2 > A > ... > 4)
  const single3S = parseYansanCombo([yCard(3, '♠')]);
  const single2S = parseYansanCombo([yCard(15, '♠')]);
  assert(single3S && single2S);
  assert.equal(canBeatYansanCombo(single3S, single2S), true, '♠3 must beat ♠2');
  assert.equal(canBeatYansanCombo(single2S, single3S), false, '♠2 must not beat ♠3');

  // 2. First turn must play ♦4 via SmartAI lead solver (exercises canonical availablePool IDs)
  const firstTurnHand: YansanCard[] = [
    yCard(4, '♦'),
    yCard(5, '♣'),
    yCard(6, '♥'),
    yCard(7, '♠'),
    yCard(8, '♦'),
    yCard(3, '♠'),
  ];
  const aiPlay = getYansanSmartAIPlay(firstTurnHand, null, {
    seat: 0,
    isFirstTurn: true,
    handsCount: [6, 13, 13, 13],
  });
  assert(aiPlay.cards.some((c) => c.id === '4-♦'), 'First turn lead must include ♦4');

  // 3. Deductive unbeatable check when all higher cards are already played
  const fullPoolExceptSpade3 = [
    yCard(3, '♠'), yCard(3, '♥'), yCard(3, '♣'), yCard(3, '♦'),
    yCard(15, '♠'), yCard(15, '♥'), yCard(15, '♣'), yCard(15, '♦'),
  ];
  const playedEverythingElse: YansanCard[][] = [
    [yCard(3, '♥'), yCard(3, '♣'), yCard(3, '♦')],
    fullPoolExceptSpade3.slice(4),
    [],
    [],
  ];
  const combo3S = parseYansanCombo([yCard(3, '♠')])!;
  assert.equal(
    isYansanComboDeductivelyUnbeatable(combo3S, [yCard(4, '♣')], playedEverythingElse, [1, 5, 5, 5]),
    true,
    '♠3 single must be deductively unbeatable'
  );

  // 4. 2v2 vs 1v3 settlements zero-sum check
  const s2v2 = calculateYansanSettlement('5-10', 0, false, null, 0, 2, [0, 2]);
  assert.equal(s2v2.seatScores.reduce((a, b) => a + b, 0), 0, '2v2 settlement must sum to 0');
  assert.equal(s2v2.seatScores[0], 10);
  assert.equal(s2v2.seatScores[1], -10);

  const s1v3 = calculateYansanSettlement('5-10', 1, false, null, 1, 1, [0, 1]);
  assert.equal(s1v3.seatScores.reduce((a, b) => a + b, 0), 0, '1v3 settlement must sum to 0');
}

function runShisanshuiTests() {
  // 1. Special hands detection
  const supremeDragon = Array.from({ length: 13 }, (_, i) => sCard(i + 2, '♠'));
  assert.equal(detectSpecialHand(supremeDragon)?.name, '至尊青龙');

  const mixedDragon = Array.from({ length: 13 }, (_, i) => sCard(i + 2, i % 2 === 0 ? '♠' : '♥'));
  assert.equal(detectSpecialHand(mixedDragon)?.name, '一条龙');

  const sixAndHalfPairs: SSSCard[] = [
    sCard(2, '♠'), sCard(2, '♥'),
    sCard(4, '♠'), sCard(4, '♥'),
    sCard(6, '♠'), sCard(6, '♥'),
    sCard(8, '♠'), sCard(8, '♥'),
    sCard(10, '♠'), sCard(10, '♥'),
    sCard(12, '♠'), sCard(12, '♥'),
    sCard(14, '♣'),
  ];
  assert.equal(detectSpecialHand(sixAndHalfPairs)?.name, '六对半');

  // 2. Foul hand detection (head stronger than mid)
  const head = [sCard(14, '♠'), sCard(14, '♥'), sCard(14, '♣')];
  const mid = [sCard(3, '♠'), sCard(5, '♥'), sCard(7, '♣'), sCard(9, '♦'), sCard(11, '♠')];
  const tail = [sCard(13, '♠'), sCard(13, '♥'), sCard(13, '♣'), sCard(13, '♦'), sCard(2, '♠')];
  assert.equal(isFoulHand(head, mid, tail), true, 'Triplet A head beating high-card mid must be foul');

  // 3. Valid hand vs weaker hand (shotgun check)
  const strong = {
    head: [sCard(14, '♠'), sCard(14, '♥'), sCard(9, '♣')],
    mid: [sCard(8, '♠'), sCard(8, '♥'), sCard(8, '♣'), sCard(4, '♦'), sCard(2, '♠')],
    tail: [sCard(13, '♠'), sCard(13, '♥'), sCard(13, '♣'), sCard(13, '♦'), sCard(5, '♠')],
  };
  const weak = {
    head: [sCard(3, '♠'), sCard(5, '♥'), sCard(7, '♣')],
    mid: [sCard(4, '♠'), sCard(6, '♥'), sCard(9, '♣'), sCard(10, '♦'), sCard(12, '♠')],
    tail: [sCard(7, '♠'), sCard(7, '♥'), sCard(11, '♣'), sCard(12, '♦'), sCard(14, '♦')],
  };
  assert.equal(isFoulHand(strong.head, strong.mid, strong.tail), false);
  assert.equal(isFoulHand(weak.head, weak.mid, weak.tail), false);
  const cmp = compareTwoPlayers(strong, weak, 1, '测试牌友');
  assert.equal(cmp.isShot, true, 'Winning all 3 tiers must trigger shotgun');
  assert(cmp.finalWater > 0, 'Stronger valid hand must yield positive water');

  // 4. Booking countdown & cycle helper with calibrated dates
  const before0600 = new Date(2026, 4, 10, 5, 30, 0);
  const cdBefore = calculateNext0600Countdown(before0600);
  assert.equal(cdBefore.hours, 0);
  assert.equal(cdBefore.minutes, 30);
  const cycleBefore = getToday0600CycleInfo(before0600);
  assert.equal(cycleBefore.latestCycleKey, '2026-05-09_0600');

  const after0600 = new Date(2026, 4, 10, 8, 0, 0);
  const cycleAfter = getToday0600CycleInfo(after0600);
  assert.equal(cycleAfter.latestCycleKey, '2026-05-10_0600');
}

function runMahjongTests() {
  // 1. Standard 4 melds + pair (14 tiles)
  const stdWin: MahjongTile[] = [
    mjTile('wan', 1, 'a'), mjTile('wan', 2, 'a'), mjTile('wan', 3, 'a'),
    mjTile('tiao', 4, 'a'), mjTile('tiao', 5, 'a'), mjTile('tiao', 6, 'a'),
    mjTile('tong', 7, 'a'), mjTile('tong', 8, 'a'), mjTile('tong', 9, 'a'),
    mjTile('wan', 5, 'a'), mjTile('wan', 5, 'b'), mjTile('wan', 5, 'c'),
    mjTile('tong', 2, 'a'), mjTile('tong', 2, 'b'),
  ];
  assert.equal(checkMahjongWin(stdWin, false).win, true, 'Standard 14-tile hand must win');

  // 2. Seven pairs with Hongzhong wildcard
  const sevenPairsWithHz: MahjongTile[] = [
    mjTile('wan', 1, 'a'), mjTile('wan', 1, 'b'),
    mjTile('wan', 3, 'a'), mjTile('wan', 3, 'b'),
    mjTile('tiao', 2, 'a'), mjTile('tiao', 2, 'b'),
    mjTile('tiao', 6, 'a'), mjTile('tiao', 6, 'b'),
    mjTile('tong', 4, 'a'), mjTile('tong', 4, 'b'),
    mjTile('tong', 8, 'a'), mjTile('tong', 8, 'b'),
    mjTile('wan', 9, 'a'), mjTile('zi', 5, 'hz'),
  ];
  assert.equal(checkMahjongWin(sevenPairsWithHz, true).win, true, 'Seven pairs with 1 Hongzhong must win');

  // 3. No-Hongzhong bonus +2 Ma in Hongzhong-6 mode
  const wallMa = Array.from({ length: 8 }, (_, i) => mjTile('wan', 1, `m${i}`)); // all 1-wan => all hit Ma!
  const noHzSettlement = computeMahjongSettlement(0, stdWin, [], wallMa, 'hongzhong-6', [0, 0, 0, 0]);
  assert.equal(noHzSettlement.maTiles.length, 8, 'No-Hongzhong in 6-ma mode must draw 8 Ma');
  assert.equal(noHzSettlement.hitMaCount, 8);
  assert.equal(noHzSettlement.netCoinsPerSeat.reduce((a, b) => a + b, 0), 0, 'Mahjong settlement must be zero-sum');

  // 4. 4 Hongzhong instant win (6-ma => +70 each, +210 total)
  const fourHzHand = [
    mjTile('zi', 5, '1'), mjTile('zi', 5, '2'), mjTile('zi', 5, '3'), mjTile('zi', 5, '4'),
    ...stdWin.slice(0, 10),
  ];
  const fourHzSettle = computeMahjongSettlement(0, fourHzHand, [], wallMa, 'hongzhong-6', [0, 0, 0, 0]);
  assert.equal(fourHzSettle.isFourHongzhong, true);
  assert.equal(fourHzSettle.payoutPerOpponent, 70);
  assert.equal(fourHzSettle.netCoinsPerSeat[0], 210);
  assert.equal(fourHzSettle.netCoinsPerSeat.reduce((a, b) => a + b, 0), 0);
}

runYansanTests();
runShisanshuiTests();
runMahjongTests();
console.log('✅ All rule engine regression tests passed (Yansan, Shisanshui, Booking, Mahjong).');
