import assert from 'node:assert/strict';
import {
  YansanCard,
  parseYansanCombo,
  canBeatYansanCombo,
  getYansanSmartAIPlay,
  isYansanComboDeductivelyUnbeatable,
  findYansanWinningSequence,
  shouldYansanAIQiangGong,
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

  // 3. Deductive unbeatable check (3-arg signature: combo, availablePool, maxOpponentHandSize)
  const combo3S = parseYansanCombo([yCard(3, '♠')])!;
  assert.equal(
    isYansanComboDeductivelyUnbeatable(combo3S, [yCard(4, '♣'), yCard(15, '♠')], 5),
    true,
    '♠3 single must be deductively unbeatable even against ♠2 in pool'
  );

  const combo3H = parseYansanCombo([yCard(3, '♥')])!;
  assert.equal(
    isYansanComboDeductivelyUnbeatable(combo3H, [yCard(3, '♠'), yCard(15, '♠')], 5),
    false,
    '♥3 single is not unbeatable while ♠3 remains in availablePool'
  );
  assert.equal(
    isYansanComboDeductivelyUnbeatable(combo3H, [yCard(15, '♠'), yCard(14, '♠')], 5),
    true,
    '♥3 single must be unbeatable once ♠3 is excluded from availablePool (played or held by practice player)'
  );

  const pair3SpadeDiamond = parseYansanCombo([yCard(3, '♠'), yCard(3, '♦')])!;
  assert.equal(
    isYansanComboDeductivelyUnbeatable(pair3SpadeDiamond, [yCard(3, '♥'), yCard(3, '♣'), yCard(15, '♠')], 5),
    true,
    '对3 (♠3+♦3) must be deductively unbeatable against remaining ♥3+♣3'
  );

  const pair3HeartClub = parseYansanCombo([yCard(3, '♥'), yCard(3, '♣')])!;
  assert.equal(
    isYansanComboDeductivelyUnbeatable(pair3HeartClub, [yCard(3, '♠'), yCard(3, '♦')], 5),
    false,
    '对3 (♥3+♣3) cannot be marked unbeatable while ♠3+♦3 remain in pool'
  );
  assert.equal(
    isYansanComboDeductivelyUnbeatable(pair3HeartClub, [yCard(3, '♦'), yCard(15, '♠'), yCard(15, '♥')], 5),
    true,
    '对3 (♥3+♣3) must be unbeatable once ♠3 is excluded (only ♦3 remains of 3s)'
  );

  const triplet3 = parseYansanCombo([yCard(3, '♠'), yCard(3, '♥'), yCard(3, '♣')])!;
  assert.equal(
    isYansanComboDeductivelyUnbeatable(triplet3, [yCard(3, '♦'), yCard(15, '♠'), yCard(15, '♥'), yCard(15, '♣')], 5),
    true,
    '三条3 must be deductively unbeatable'
  );

  const triplet2 = parseYansanCombo([yCard(15, '♠'), yCard(15, '♥'), yCard(15, '♣')])!;
  assert.equal(
    isYansanComboDeductivelyUnbeatable(triplet2, [yCard(3, '♠'), yCard(3, '♥'), yCard(14, '♠'), yCard(14, '♥'), yCard(14, '♣')], 5),
    true,
    '三条2 must be unbeatable when fewer than 3 threes remain in pool'
  );

  const fourTwo = parseYansanCombo([yCard(15, '♠'), yCard(15, '♥'), yCard(15, '♣'), yCard(15, '♦'), yCard(4, '♣')])!;
  assert.equal(
    isYansanComboDeductivelyUnbeatable(fourTwo, [yCard(3, '♠'), yCard(4, '♠'), yCard(5, '♠'), yCard(6, '♠'), yCard(7, '♠')], 5),
    false,
    '四带一2 is beatable if a straight flush can exist in pool with maxOpponentHandSize >= 5'
  );
  assert.equal(
    isYansanComboDeductivelyUnbeatable(fourTwo, [yCard(3, '♠'), yCard(4, '♠'), yCard(5, '♠'), yCard(6, '♠'), yCard(7, '♠')], 4),
    true,
    '四带一2 must be unbeatable when maxOpponentHandSize < 5'
  );
  assert.equal(
    isYansanComboDeductivelyUnbeatable(fourTwo, [yCard(3, '♠'), yCard(3, '♥'), yCard(3, '♣'), yCard(14, '♠'), yCard(13, '♥')], 5),
    true,
    '四带一2 must be unbeatable when no higher four-of-a-kind or straight flush exists in pool'
  );

  const royalSpadeSF = parseYansanCombo([yCard(3, '♠'), yCard(4, '♠'), yCard(5, '♠'), yCard(6, '♠'), yCard(7, '♠')])!;
  assert.equal(
    isYansanComboDeductivelyUnbeatable(royalSpadeSF, [yCard(3, '♥'), yCard(4, '♥'), yCard(5, '♥'), yCard(6, '♥'), yCard(7, '♥')], 13),
    true,
    '♠3-4-5-6-7 同花顺 must be deductively unbeatable'
  );

  // 4. SmartAI must NEVER answer a single/pair/triplet with a 5-card combo during emergency follow
  const handWith5CardOnly = [
    yCard(4, '♠'), yCard(5, '♠'), yCard(6, '♠'), yCard(7, '♠'), yCard(8, '♠'),
  ];
  const emergencyFollowSingle = getYansanSmartAIPlay(handWith5CardOnly, single3S, {
    seat: 1,
    handsCount: [1, 5, 8, 8],
  });
  assert.equal(emergencyFollowSingle.cards, null, 'AI must pass rather than answer a single with a 5-card combo');

  const highPairA = parseYansanCombo([yCard(14, '♠'), yCard(14, '♥')])!;
  const emergencyFollowPair = getYansanSmartAIPlay(handWith5CardOnly, highPairA, {
    seat: 1,
    handsCount: [1, 5, 8, 8],
  });
  assert.equal(emergencyFollowPair.cards, null, 'AI must pass rather than answer a pair with a 5-card combo');

  // 5. Smart AI control preservation: never waste ♥3/♣3/♦3 or 对3 on tiny 5/对4 midgame
  const handWithHeart3And9 = [
    yCard(3, '♥'), yCard(9, '♠'), yCard(4, '♣'), yCard(4, '♦'), yCard(7, '♠'), yCard(7, '♥'),
  ];
  const single5S = parseYansanCombo([yCard(5, '♠')])!;
  single5S.seat = 0;
  const follow5 = getYansanSmartAIPlay(handWithHeart3And9, single5S, {
    seat: 1,
    handsCount: [6, 6, 8, 8],
  });
  assert(follow5.cards && follow5.cards[0].rank === 9, 'AI must play 9♠ instead of wasting ♥3 on a 5♠');

  const handWithHeart3AndStraight = [
    yCard(3, '♥'), yCard(4, '♣'), yCard(5, '♠'), yCard(6, '♥'), yCard(7, '♦'), yCard(8, '♠'),
  ];
  const holdHeart3 = getYansanSmartAIPlay(handWithHeart3AndStraight, single5S, {
    seat: 1,
    handsCount: [6, 6, 8, 8],
  });
  assert.equal(holdHeart3.cards, null, 'AI must pass rather than waste ♥3 or break 4-8 straight on a tiny 5');

  const pair4Target = parseYansanCombo([yCard(4, '♠'), yCard(4, '♥')])!;
  pair4Target.seat = 0;
  const handWithPair3AndPair8 = [
    yCard(3, '♥'), yCard(3, '♦'), yCard(8, '♠'), yCard(8, '♥'), yCard(10, '♣'), yCard(11, '♦'),
  ];
  const followPair4 = getYansanSmartAIPlay(handWithPair3AndPair8, pair4Target, {
    seat: 1,
    handsCount: [6, 6, 8, 8],
  });
  assert(followPair4.cards && followPair4.cards[0].rank === 8, 'AI must play 对8 instead of wasting 对3 on 对4');

  // 6. Smart AI midgame free lead: never dump 同花顺 / 四带一 ahead of weaker 顺子
  const handStraightAndSF = [
    yCard(4, '♠'), yCard(5, '♠'), yCard(6, '♠'), yCard(7, '♠'), yCard(8, '♠'),
    yCard(4, '♥'), yCard(5, '♣'), yCard(6, '♦'), yCard(7, '♥'), yCard(8, '♣'),
    yCard(9, '♦'), yCard(10, '♣'),
  ];
  const freeLeadRes = getYansanSmartAIPlay(handStraightAndSF, null, {
    seat: 1,
    handsCount: [10, 12, 10, 10],
  });
  const freeLeadCombo = parseYansanCombo(freeLeadRes.cards || []);
  assert(
    freeLeadCombo && freeLeadCombo.type === '5_card' && freeLeadCombo.comboTier === 1,
    'Midgame free lead must shed ordinary 顺子 before 同花顺'
  );

  // 7. Smart AI must block 1-card unknown seat (never feed small single)
  const handBlockingBaodan = [yCard(4, '♣'), yCard(9, '♠'), yCard(9, '♥'), yCard(11, '♦')];
  const blockUnknown1Card = getYansanSmartAIPlay(handBlockingBaodan, null, {
    seat: 2,
    handsCount: [8, 1, 4, 8], // seat 1 (unknown) only has 1 card left!
  });
  assert(
    blockUnknown1Card.cards && blockUnknown1Card.cards.length === 2 && blockUnknown1Card.cards[0].rank === 9,
    'AI must lead pair/combo rather than feeding a 1-card unknown player'
  );

  // 8. Smart AI in 1v3 QiangGong must never block ally when downstream is also ally
  const qgAllySingle6 = parseYansanCombo([yCard(6, '♣')])!;
  qgAllySingle6.seat = 0;
  const aiDefenseHand = [yCard(10, '♠'), yCard(11, '♥'), yCard(4, '♦'), yCard(5, '♦'), yCard(7, '♣'), yCard(9, '♣')];
  const yieldInQG = getYansanSmartAIPlay(aiDefenseHand, qgAllySingle6, {
    seat: 2, // seat 2 -> downstream is seat 1 (ally!) while seat 3 is QiangGong solo enemy
    handsCount: [6, 6, 6, 6],
    isQiangGong: true,
    qiangGongSeat: 3,
  });
  assert.equal(yieldInQG.cards, null, 'AI must yield to ally when downstream is also an ally in 1v3');

  // 9. N-step forced win sequence & follow snatching forced win
  const threeStepHand = [
    yCard(3, '♠'),
    yCard(15, '♠'), yCard(15, '♥'),
    yCard(4, '♣'), yCard(5, '♦'), yCard(6, '♥'), yCard(7, '♠'), yCard(8, '♣'),
  ];
  const threeStepWin = findYansanWinningSequence(
    threeStepHand,
    [yCard(14, '♠'), yCard(13, '♣'), yCard(9, '♦'), yCard(10, '♥'), yCard(11, '♠')], // no 3s left in pool
    5
  );
  assert(threeStepWin && threeStepWin.length > 0, 'N-step solver must recognize ♠3 -> 对2 -> 顺子 forced win');

  const singleKS = parseYansanCombo([yCard(13, '♠')])!;
  singleKS.seat = 1;
  // Case A: All other 3s are played, so ♥2 itself is deductively unbeatable and keeps ♠3+♠2+4-8 forced win
  const followForcedWin2 = getYansanSmartAIPlay(threeStepHand, singleKS, {
    seat: 2,
    handsCount: [5, 5, 8, 5],
    seatPlayedCards: [[yCard(3, '♥'), yCard(3, '♣'), yCard(3, '♦')], [], [], []],
  });
  assert(
    followForcedWin2.cards && followForcedWin2.cards.length === 1 && followForcedWin2.cards[0].rank === 15 && followForcedWin2.tacticalIntent === 'win_clear',
    'AI should snatch forced-win lead with unbeatable ♥2 when all 3s are accounted for'
  );

  // Case B: ♦3 is still in opponent hands, so 2s are beatable; AI must snatch lead with ♠3 so 对2+顺子 wins guaranteed
  const followForcedWin3 = getYansanSmartAIPlay(threeStepHand, singleKS, {
    seat: 2,
    handsCount: [5, 5, 8, 5],
    seatPlayedCards: [[yCard(3, '♥'), yCard(3, '♣')], [], [], []],
  });
  assert(
    followForcedWin3.cards && followForcedWin3.cards.length === 1 && followForcedWin3.cards[0].rank === 3 && followForcedWin3.tacticalIntent === 'win_clear',
    'AI must snatch lead with ♠3 when ♦3 is still out and remaining hand (对2+顺子) forms a 100% forced win'
  );

  // 10. Smart QiangGong evaluation rejects weak scattered hands and accepts monster hands
  const weakQGHand = [
    yCard(3, '♠'), yCard(14, '♠'), yCard(13, '♦'), yCard(13, '♣'),
    yCard(4, '♣'), yCard(4, '♥'), yCard(6, '♦'), yCard(7, '♠'), yCard(9, '♥'),
    yCard(9, '♣'), yCard(10, '♦'), yCard(11, '♣'), yCard(12, '♥'),
  ];
  assert.equal(shouldYansanAIQiangGong(weakQGHand), false, 'Weak scattered hand with ♠3+♠A must not QiangGong');

  const monsterQGHand = [
    yCard(3, '♠'), yCard(14, '♠'), yCard(15, '♠'), yCard(15, '♥'),
    yCard(12, '♠'), yCard(12, '♥'), yCard(12, '♣'), yCard(12, '♦'),
    yCard(4, '♣'), yCard(5, '♦'), yCard(6, '♥'), yCard(7, '♠'), yCard(8, '♣'),
  ];
  assert.equal(shouldYansanAIQiangGong(monsterQGHand), true, 'Monster low-turn hand with ♠3+♠A+对2+四带一+顺子 should QiangGong');

  // 11. 2v2 vs 1v3 settlements zero-sum check
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

  // 5. Unsorted winningHand + object melds must be normalized & sorted (wan -> tiao -> tong -> zi)
  const unsortedWin: MahjongTile[] = [
    mjTile('zi', 5, 's1'),
    mjTile('tong', 9, 's2'),
    mjTile('wan', 1, 's3'),
    mjTile('tiao', 4, 's4'),
    mjTile('wan', 3, 's5'),
    mjTile('tong', 2, 's6'),
    mjTile('wan', 2, 's7'),
    mjTile('tiao', 5, 's8'),
  ];
  const rawObjectMelds: any[] = [
    { type: 'peng', tile: mjTile('tong', 7, 'm1') },
    [mjTile('tiao', 3, 'm2a'), mjTile('tiao', 3, 'm2b'), mjTile('tiao', 3, 'm2c')],
  ];
  const sortedSettle = computeMahjongSettlement(1, unsortedWin, rawObjectMelds, wallMa, 'hongzhong-6', [0, 0, 0, 0]);
  assert.deepEqual(
    sortedSettle.winningHand.map((t) => `${t.type}-${t.value}`),
    ['wan-1', 'wan-2', 'wan-3', 'tiao-4', 'tiao-5', 'tong-2', 'tong-9', 'zi-5'],
    'computeMahjongSettlement must sort winningHand deterministically'
  );
  assert.equal(sortedSettle.winningMelds.length, 2);
  assert.equal(sortedSettle.winningMelds[0].length, 3);
}

runYansanTests();
runShisanshuiTests();
runMahjongTests();
console.log('✅ All rule engine regression tests passed (Yansan, Shisanshui, Booking, Mahjong).');
