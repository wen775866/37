import { WebSocketServer, WebSocket } from 'ws';
import { loadDatabase, saveDatabase, recordServerPointsTx } from './serverStorage.ts';
import {
  ackServerUnreadSettlements,
  advanceServerBookingCarriage,
  getServerBookingState,
  initServerBookingInventory,
  pickServerBookingTable,
  runServer0600SettlementSweep,
  selectServerBookingSeat,
  simulateServerBookingSettlement,
  submitServerBookingHand,
  type SettledUserNotification,
} from './games/shisanshui/serverBookingService.ts';
import { presenceTracker } from './presenceTracker.ts';
import { generateRoomDeal } from './gameDeckService.ts';
import { createDefaultBoardState, getSceneRequiredCoins, type AuthoritativeBoardState } from './gameLogic/index.ts';
import { checkMahjongWin, computeMahjongSettlement, sortMahjongTiles } from './engine/mahjongRules.ts';
import {
  parseYansanCombo,
  canBeatYansanCombo,
  getYansanSmartAIPlay,
  getYansanRankWeight,
  isYansanComboDeductivelyUnbeatable,
  calculateYansanSettlement,
  calculateYansanSurrenderSettlement,
  detectYansanSpecialHolders,
  type YansanCard,
} from './engine/yansanRules.ts';
import {
  autoArrangeThirteen,
  compareTwoPlayers,
  detectSpecialHand,
  evaluate3CardTier,
  evaluate5CardTier,
  isFoulHand,
  type SSSCard,
} from './engine/shisanshuiRules.ts';

export type { AuthoritativeBoardState };

export interface ScenePlayer {
  id: string;
  name: string;
  avatar: string;
  rating: number;
  coins: number;
  seat: number;
  isSimulated?: boolean;
  isReady?: boolean;
  socketId?: string;
  isDisconnected?: boolean;
  isAutoManaged?: boolean;
  originalId?: string;
  originalName?: string;
}

export interface SceneWaitingRoom {
  id: string;
  gameType: string;
  sceneMode: string;
  sceneName: string;
  maxPlayers: number;
  players: ScenePlayer[];
  status: 'waiting' | 'starting' | 'playing' | 'finished';
  createdAt: number;
  lastTurnTs?: number;
  deal?: any;
  roundIndex?: number;
}

export interface ActiveChallengeRecord {
  id: string;
  senderId: string;
  senderName: string;
  avatar: string;
  gameType: string;
  sceneMode: string;
  sceneName: string;
  text: string;
  status: 'open' | 'accepted' | 'overwritten' | 'transferred' | 'cancelled' | 'removed';
  acceptedBy?: { id: string; name: string };
  timestamp: string;
  createdAt: number;
}

function isBotLikePlayer(p: any): boolean {
  if (!p) return false;
  return Boolean(
    p.isAi ||
      p.isSimulated ||
      p.isBot ||
      p.id?.startsWith?.('BOT-') ||
      p.id?.startsWith?.('sim-') ||
      p.id?.startsWith?.('P-sim-')
  );
}

export function sanitizeDealForSeat(gameType: string, deal: any, recipientSeat: number): any {
  if (!deal || typeof deal !== 'object') return deal;
  const copy: any = { ...deal };
  delete copy.deck;
  delete copy.initialSeatCards;

  const maskOpponentHand = (hand: any[], s: number) => {
    if (!Array.isArray(hand)) return [];
    if (s === recipientSeat) return [...hand];
    if (gameType === 'shisanshui') {
      return hand.map((_, idx) => ({
        id: `hidden-${s}-${idx}`,
        rank: 0,
        suit: '?',
        suitVal: 0,
        label: '?',
        isRed: false,
        hidden: true,
      }));
    }
    if (gameType === 'yansan') {
      return hand.map((_, idx) => ({
        id: `hidden-${s}-${idx}`,
        rank: 0,
        suitVal: 0,
        label: '?',
        suit: '?',
        isRed: false,
        hidden: true,
      }));
    }
    // mahjong
    return hand.map((_, idx) => ({
      id: `hidden-${s}-${idx}`,
      type: 'wan',
      value: 1,
      text: '一万',
      color: '#DC2626',
      hidden: true,
    }));
  };

  if (Array.isArray(deal.seatCards)) {
    copy.seatCards = deal.seatCards.map((hand: any[], s: number) => maskOpponentHand(hand, s));
  } else if (deal.seatCards && typeof deal.seatCards === 'object') {
    const maskedObj: Record<number, any[]> = {};
    for (const [seatKey, hand] of Object.entries(deal.seatCards)) {
      const s = Number(seatKey);
      maskedObj[s] = maskOpponentHand(Array.isArray(hand) ? hand : [], s);
    }
    copy.seatCards = maskedObj;
  }

  if (gameType === 'mahjong' && Array.isArray(deal.remainingWall)) {
    copy.remainingWall = deal.remainingWall.map((_: any, idx: number) => ({
      id: `hidden-wall-${idx}`,
      type: 'wan',
      value: 1,
      text: '一万',
      color: '#DC2626',
      hidden: true,
    }));
  }

  return copy;
}

function maskHiddenMahjongTile(tile: any): any {
  if (!tile) return null;
  return {
    id: tile.id || 'hidden-tile',
    type: 'wan',
    value: 1,
    text: '一万',
    color: '#DC2626',
    hidden: true,
  };
}

function sanitizeBoardStateForSeat(bs: any, gameType: string, recipientSeat: number): any {
  if (!bs || gameType !== 'mahjong' || !bs.extraState) return bs;
  if (bs.phase === 'ended') return bs;
  const drawnSeat = bs.extraState.lastDrawnSeat;
  const drawnTile = bs.extraState.lastDrawnTile;
  if (!drawnTile || drawnSeat === recipientSeat) return bs;
  return {
    ...bs,
    extraState: {
      ...bs.extraState,
      lastDrawnTile: maskHiddenMahjongTile(drawnTile),
    },
  };
}

function createYansanStandardDeck(): YansanCard[] {
  const suits: { suit: '♠' | '♥' | '♣' | '♦'; suitVal: number; isRed: boolean }[] = [
    { suit: '♠', suitVal: 4, isRed: false },
    { suit: '♥', suitVal: 3, isRed: true },
    { suit: '♣', suitVal: 2, isRed: false },
    { suit: '♦', suitVal: 1, isRed: true },
  ];
  const ranks = [
    { rank: 3, label: '3' }, { rank: 4, label: '4' }, { rank: 5, label: '5' },
    { rank: 6, label: '6' }, { rank: 7, label: '7' }, { rank: 8, label: '8' },
    { rank: 9, label: '9' }, { rank: 10, label: '10' }, { rank: 11, label: 'J' },
    { rank: 12, label: 'Q' }, { rank: 13, label: 'K' }, { rank: 14, label: 'A' },
    { rank: 15, label: '2' },
  ];
  const deck: YansanCard[] = [];
  for (const r of ranks) {
    for (const s of suits) {
      deck.push({
        id: `${r.label}-${s.suit}`,
        rank: r.rank,
        suitVal: s.suitVal,
        label: r.label,
        suit: s.suit,
        isRed: s.isRed,
      });
    }
  }
  return deck;
}

export function createRealtimeHub(wss: WebSocketServer): (payload: unknown) => void {
  const rooms = new Map<string, any>([
    [
      'RM-202',
      {
        id: 'RM-202',
        title: '风雷堂 · 经典烟三四人赛',
        gameType: 'yansan',
        status: 'playing',
        players: [
          { id: 'P-4', name: '快枪手张三', rating: 2010, seat: 0 },
          { id: 'P-5', name: '关门客李四', rating: 1940, seat: 1 },
          { id: 'P-6', name: '岭南少侠', rating: 1870, seat: 2 },
        ],
        spectators: 9,
        turnSeat: 0,
        moveCount: 6,
        modeLabel: '方块四首出 · 四人争锋',
        chat: [{ id: 'c2', sender: '快枪手张三', text: '方块四首出直接开顺子！', timestamp: '10:04' }],
        boardState: createDefaultBoardState('RM-202', 'yansan'),
      },
    ],
    [
      'RM-204',
      {
        id: 'RM-204',
        title: '水镜阁 · 经典十三水',
        gameType: 'shisanshui',
        status: 'playing',
        players: [
          { id: 'P-11', name: '罗宋巧手', rating: 2060, seat: 0 },
          { id: 'P-12', name: '倒水掌门', rating: 1850, seat: 1 },
          { id: 'P-13', name: '十三飞龙', rating: 2200, seat: 2 },
          { id: 'P-14', name: '七星居士', rating: 1970, seat: 3 },
        ],
        spectators: 18,
        turnSeat: 0,
        moveCount: 1,
        modeLabel: '头中尾三道 · 智能理牌',
        chat: [{ id: 'c4', sender: '十三飞龙', text: '尾道葫芦中道同花，防倒水稳如磐石。', timestamp: '10:06' }],
        boardState: createDefaultBoardState('RM-204', 'shisanshui'),
      },
    ],
    [
      'RM-205',
      {
        id: 'RM-205',
        title: '雀神楼 · 经典国标麻将',
        gameType: 'mahjong',
        status: 'playing',
        players: [
          { id: 'P-15', name: '天和雀圣', rating: 2240, seat: 0 },
          { id: 'P-16', name: '清一色老叟', rating: 2110, seat: 1 },
          { id: 'P-17', name: '大三元道长', rating: 2180, seat: 2 },
          { id: 'P-18', name: '十三幺隐士', rating: 2290, seat: 3 },
        ],
        spectators: 31,
        turnSeat: 0,
        moveCount: 12,
        modeLabel: '万条筒字 · 碰杠听胡',
        chat: [{ id: 'c5', sender: '天和雀圣', text: '自摸万字清一色，听牌在手！', timestamp: '10:07' }],
        boardState: createDefaultBoardState('RM-205', 'mahjong'),
      },
    ],
  ]);

  const sceneWaitingRooms = new Map<string, SceneWaitingRoom>();
  const activeChallenges: ActiveChallengeRecord[] = [];

  presenceTracker.setReferences({ rooms, sceneWaitingRooms, wss });

  function broadcast(payload: unknown) {
    try {
      const raw = JSON.stringify(payload);
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.send(raw);
          } catch {}
        }
      }
    } catch {}
  }

  function findOpenSocketForPlayer(pl: any): WebSocket | null {
    if (!pl) return null;
    if (pl.socketId) {
      for (const client of wss.clients) {
        if ((client as any).socketId === pl.socketId && client.readyState === WebSocket.OPEN) {
          return client;
        }
      }
    }
    for (const client of wss.clients) {
      if (
        client.readyState === WebSocket.OPEN &&
        (client as any).scenePlayerId &&
        (client as any).scenePlayerId === pl.id
      ) {
        return client;
      }
    }
    return null;
  }

  function sendSanitizedToRoom(
    room: { id: string; players?: any[] },
    buildPayloadForSeat: (seat: number, player: any) => unknown
  ) {
    const sentSockets = new Set<WebSocket>();
    for (const pl of room.players || []) {
      if (!pl || isBotLikePlayer(pl)) continue;
      const targetWs = findOpenSocketForPlayer(pl);
      if (targetWs && !sentSockets.has(targetWs)) {
        sentSockets.add(targetWs);
        try {
          targetWs.send(JSON.stringify(buildPayloadForSeat(typeof pl.seat === 'number' ? pl.seat : 0, pl)));
        } catch {}
      }
    }
    // Fallback for any live socket bound to room.id that wasn't matched directly
    for (const client of wss.clients) {
      if (
        client.readyState === WebSocket.OPEN &&
        !sentSockets.has(client) &&
        (client as any).sceneRoomId === room.id
      ) {
        const pid = (client as any).scenePlayerId;
        const matched = (room.players || []).find((p: any) => p.id === pid);
        const s = matched && typeof matched.seat === 'number' ? matched.seat : -1;
        try {
          client.send(JSON.stringify(buildPayloadForSeat(s, matched || null)));
        } catch {}
      }
    }
  }

  function broadcastTeahousePlayers() {
    try {
      const db = loadDatabase();
      const players = presenceTracker.getAllPlayers(db.profiles || {});
      broadcast({
        type: 'teahouse_players_update',
        count: players.length,
        onlineCount: players.filter((p: any) => p.isOnline).length,
        players,
      });
    } catch {}
  }

  const SETTLEMENT_TIMEOUT_MS = 60000;

  function resetSceneRoomReadyAndCleanDisconnected(roomId: string) {
    const authRoom = rooms.get(roomId);
    const targetSceneRoom = sceneWaitingRooms.get(roomId);
    const expiresAt =
      (authRoom as any)?.settlementExpiresAt ||
      (targetSceneRoom as any)?.settlementExpiresAt ||
      Date.now() + SETTLEMENT_TIMEOUT_MS;

    if (authRoom) {
      (authRoom as any).settlementExpiresAt = expiresAt;
      if (authRoom.players) {
        authRoom.players.forEach((pl: any) => {
          pl.isReady = isBotLikePlayer(pl);
        });
      }
    }
    if (targetSceneRoom) {
      targetSceneRoom.status = 'finished';
      (targetSceneRoom as any).settlementExpiresAt = expiresAt;
      targetSceneRoom.players.forEach((pl: any) => {
        pl.isReady = isBotLikePlayer(pl);
      });
      broadcast({
        type: 'scene_room_update',
        roomId: targetSceneRoom.id,
        gameType: targetSceneRoom.gameType,
        sceneMode: targetSceneRoom.sceneMode,
        players: targetSceneRoom.players,
        maxPlayers: targetSceneRoom.maxPlayers,
        status: targetSceneRoom.status,
        settlementExpiresAt: expiresAt,
        serverTs: Date.now(),
      });
    }
  }

  function settleRoomCoins(
    room: any,
    coinsDeltaBySeat: number[],
    gameType: string,
    meta: { ratingDeltaBySeat?: number[] } = {}
  ) {
    if (!room) return;
    const roundKey = `${gameType}_${room.id}_r${room.roundIndex || 1}_${(room as any).deal?.dealId || ''}`;
    if (room._coinsSettledRoundKey === roundKey) {
      return;
    }
    room._coinsSettledRoundKey = roundKey;

    try {
      const db = loadDatabase();
      let dirty = false;
      for (const pl of room.players || []) {
        if (!pl || typeof pl.seat !== 'number' || isBotLikePlayer(pl)) continue;
        const delta = Math.trunc(coinsDeltaBySeat[pl.seat] || 0);
        const profile = db.profiles?.[pl.id];
        if (profile) {
          profile.coins = Math.max(0, (profile.coins || 0) + delta);
          if (meta.ratingDeltaBySeat && typeof meta.ratingDeltaBySeat[pl.seat] === 'number') {
            profile.rating = Math.max(1000, (profile.rating || 1800) + Math.trunc(meta.ratingDeltaBySeat[pl.seat]));
            profile.level = Math.max(1, Math.min(10, Math.floor(profile.rating / 500)));
          }
          profile.updatedAt = Date.now();
          if (delta !== 0) {
            const gLabel = gameType === 'mahjong' ? '经典国标麻将' : gameType === 'shisanshui' ? '水镜十三水' : '经典烟三';
            recordServerPointsTx(
              db,
              pl.id,
              delta >= 0 ? 'game_win' : 'game_loss',
              `${gLabel} · 牌桌结算 (${delta >= 0 ? '+' : ''}${delta})`,
              delta,
              profile.coins
            );
          }
          dirty = true;
          broadcast({
            type: 'user_coins_updated',
            userId: pl.id,
            coins: profile.coins,
            delta,
            rating: profile.rating,
            level: profile.level,
            source: 'match_settlement',
            gameType,
            roomId: room.id,
            roundKey,
          });
        }
      }
      if (dirty) {
        saveDatabase(db);
      }
    } catch (e) {
      console.error(`Error settling ${gameType} coins in database:`, e);
    }
  }

  function executeMahjongWinSettlement(room: any, winnerSeat: number, isFourHz: boolean, pPayload?: any) {
    if (!room || !room.boardState) return;
    if (room.boardState.phase === 'ended') return;
    const settlementExpiresAt = Date.now() + SETTLEMENT_TIMEOUT_MS;
    room.boardState.winnerSeat = winnerSeat;
    room.boardState.phase = 'ended';
    if (room.boardState.extraState) {
      room.boardState.extraState.claimWindow = null;
      room.boardState.extraState.pendingPengSeat = null;
    }
    room.status = 'finished';
    room.settlementExpiresAt = settlementExpiresAt;

    const dealObj = room.deal || {};
    const authSeatCards = Array.isArray(dealObj.seatCards?.[winnerSeat])
      ? dealObj.seatCards[winnerSeat].filter((t: any) => t && !t.hidden)
      : [];
    const payloadWinnerCards = Array.isArray(pPayload?.winningHand)
      ? pPayload.winningHand.filter((t: any) => t && !t.hidden)
      : [];
    const rawWinnerHand =
      authSeatCards.length > 0
        ? authSeatCards
        : payloadWinnerCards.length > 0
          ? payloadWinnerCards
          : pPayload?.tile && !pPayload.tile.hidden
            ? [pPayload.tile]
            : [];
    const winnerHand = sortMahjongTiles(rawWinnerHand);

    const remWall = dealObj.remainingWall || [];
    const sMode = room.sceneMode || 'hongzhong-6';

    const serverMeldsRaw = room.boardState.extraState?.mahjongMelds?.[winnerSeat] || [];
    const fallbackWinningMelds = Array.isArray(serverMeldsRaw)
      ? serverMeldsRaw
          .map((m: any) =>
            Array.isArray(m)
              ? m
              : Array.isArray(m?.tiles)
                ? m.tiles
                : m?.tile
                  ? Array(m.type === 'gang' ? 4 : 3).fill(m.tile)
                  : []
          )
          .filter((arr: any[]) => arr.length > 0)
      : [];
    const resolvedWinningMelds =
      fallbackWinningMelds.length > 0
        ? fallbackWinningMelds
        : Array.isArray(pPayload?.winningMelds)
          ? pPayload.winningMelds
          : [];

    const resolvedKongScores: [number, number, number, number] =
      Array.isArray(room.boardState.seatKongScores) && room.boardState.seatKongScores.length === 4
        ? room.boardState.seatKongScores
        : Array.isArray(pPayload?.seatKongScores) && pPayload.seatKongScores.length === 4
          ? pPayload.seatKongScores
          : [0, 0, 0, 0];

    const stl = computeMahjongSettlement(
      winnerSeat,
      winnerHand,
      resolvedWinningMelds,
      remWall,
      sMode,
      resolvedKongScores,
      isFourHz,
      pPayload?.maTiles
    );

    room.boardState.winDesc = stl.isFourHongzhong ? '摸到四张红中直接胡牌' : '自摸和牌';
    room.boardState.settlement = {
      ...stl,
      winnerSeat,
      isFourHz: stl.isFourHongzhong,
      settlementExpiresAt,
      winDesc: room.boardState.winDesc,
    };

    settleRoomCoins(room, stl.netCoinsPerSeat, 'mahjong');

    const nowTs = Date.now();
    const huEvtPayload = {
      action: 'hu',
      seat: winnerSeat,
      absSeat: winnerSeat,
      winner: winnerSeat,
      isFourHz: stl.isFourHongzhong,
      winningHand: stl.winningHand,
      winningMelds: stl.winningMelds,
      maCount: stl.maCount,
      maTiles: stl.maTiles,
      hitMaCount: stl.hitMaCount,
      payoutPerOpponent: stl.payoutPerOpponent,
      netCoinsPerSeat: stl.netCoinsPerSeat,
      seatKongScores: stl.seatKongScores,
      rewardCoins: stl.netCoinsPerSeat[winnerSeat],
      reason: stl.isFourHongzhong ? 'four_hongzhong' : 'zimo_hu',
      settlementExpiresAt,
      serverTs: nowTs,
    };

    broadcast({
      type: 'game_event',
      roomId: room.id,
      seat: winnerSeat,
      event: huEvtPayload,
      payload: huEvtPayload,
      boardState: room.boardState,
    });

    resetSceneRoomReadyAndCleanDisconnected(room.id);
  }

  function executeMahjongDrawStalemate(room: any, triggerSeat: number, reasonMsg = '牌墙抓毕，本局荒庄（流局）！') {
    if (!room || !room.boardState) return;
    if (room.boardState.phase === 'ended') return;

    const nowTs = Date.now();
    const settlementExpiresAt = nowTs + SETTLEMENT_TIMEOUT_MS;
    const bs = room.boardState;
    bs.phase = 'ended';
    bs.isDraw = true;
    if (!bs.extraState) bs.extraState = {};
    bs.extraState.wallRemaining = 0;
    bs.extraState.pendingPengSeat = null;
    bs.extraState.claimWindow = null;
    room.status = 'finished';
    room.settlementExpiresAt = settlementExpiresAt;
    room.moveCount = (room.moveCount || 0) + 1;
    bs.actionSeq = (bs.actionSeq || 0) + 1;
    bs.moveCount = room.moveCount;
    bs.updatedAt = nowTs;

    const kongScores: [number, number, number, number] =
      Array.isArray(bs.seatKongScores) && bs.seatKongScores.length === 4
        ? [
            Number(bs.seatKongScores[0]) || 0,
            Number(bs.seatKongScores[1]) || 0,
            Number(bs.seatKongScores[2]) || 0,
            Number(bs.seatKongScores[3]) || 0,
          ]
        : [0, 0, 0, 0];
    const hasKongDeltas = kongScores.some((k) => k !== 0);
    if (hasKongDeltas) {
      settleRoomCoins(room, kongScores, 'mahjong');
    }

    bs.settlement = {
      isDraw: true,
      message: reasonMsg,
      seatKongScores: kongScores,
      netCoinsPerSeat: kongScores,
      settlementExpiresAt,
    };

    resetSceneRoomReadyAndCleanDisconnected(room.id);

    const stalematePayload = {
      action: 'draw_stalemate',
      isDraw: true,
      reason: 'wall_exhausted',
      message: reasonMsg,
      msg: reasonMsg,
      seatKongScores: kongScores,
      netCoinsPerSeat: kongScores,
      settlementExpiresAt,
      serverTs: nowTs,
    };

    broadcast({
      type: 'game_event',
      roomId: room.id,
      seat: triggerSeat,
      event: stalematePayload,
      payload: stalematePayload,
      moveCount: room.moveCount,
      boardState: bs,
    });
  }

  function computeMahjongClaimPendingSeats(room: any, bs: any, discardSeat: number, discTile: any): number[] {
    if (!discTile) return [];
    const isHongzhongMode = room.sceneMode?.includes('hongzhong') ?? true;
    const isRedDragonTile = (t: any) =>
      Boolean(t && t.type === 'zi' && (Number(t.value) === 5 || t.text === '红中' || t.isRedDragon));
    if (isHongzhongMode && isRedDragonTile(discTile)) return [];

    const seatCardsAll = (room as any).deal?.seatCards;
    if (!Array.isArray(seatCardsAll)) return [];

    const pending: number[] = [];
    for (let s = 0; s < 4; s++) {
      if (s === discardSeat) continue;
      const pl = room.players?.find((x: any) => x.seat === s);
      const isAuto = Boolean(
        pl?.isAutoManaged ||
          pl?.isDisconnected ||
          isBotLikePlayer(pl) ||
          bs.autoManagedSeats?.[s]
      );
      if (isAuto) continue;
      const hand = seatCardsAll[s];
      if (!Array.isArray(hand)) continue;
      const matchCount = hand.filter((c: any) => c.type === discTile.type && Number(c.value) === Number(discTile.value)).length;
      if (matchCount >= 2 && hand.length % 3 === 1) {
        pending.push(s);
      }
    }
    return pending;
  }

  function resolveYansanFinish(room: any, triggerWinnerSeat: number, holders?: ReturnType<typeof detectYansanSpecialHolders>) {
    if (!room || !room.boardState) return;
    const bs = room.boardState;
    if (bs.phase === 'ended') return;

    const dealObj = (room as any).deal || {};
    const h =
      holders ||
      detectYansanSpecialHolders(
        dealObj.initialSeatCards || dealObj.seatCards || [[], [], [], []],
        bs.extraState?.seatPlayedCards
      );
    const fin = Array.isArray(bs.finishedSeats) ? [...bs.finishedSeats] : [];
    const isQG = Boolean(bs.extraState?.isQiangGongActive);
    const qgSeat = bs.extraState?.qiangGongSeat ?? null;
    const firstFin = fin[0] ?? triggerWinnerSeat;

    const stl = calculateYansanSettlement(
      room.sceneMode || '5-10',
      firstFin,
      isQG,
      qgSeat,
      h.spade3Seat,
      h.spadeASeat,
      fin
    );

    bs.winnerSeat = stl.winnerSeat;
    bs.phase = 'ended';
    room.status = 'finished';
    bs.finishedSeats = fin;
    const enrichedStl = {
      ...stl,
      spade3Seat: h.spade3Seat,
      spadeASeat: h.spadeASeat,
      soloSeat: h.soloSeat,
    };
    bs.allianceScoreResult = enrichedStl;
    bs.settlement = enrichedStl;
    room.moveCount = (room.moveCount || 0) + 1;
    bs.moveCount = room.moveCount;
    bs.actionSeq = (bs.actionSeq || 0) + 1;
    bs.updatedAt = Date.now();

    settleRoomCoins(room, stl.seatScores, 'yansan', {
      ratingDeltaBySeat: stl.seatScores.map((pts) => Math.round(pts * 0.8)),
    });

    resetSceneRoomReadyAndCleanDisconnected(room.id);

    const finPayload = {
      action: 'finish',
      seat: firstFin,
      winner: stl.winnerSeat,
      finishedSeats: fin,
      spade3Seat: h.spade3Seat,
      spadeASeat: h.spadeASeat,
      soloSeat: h.soloSeat,
      allianceScoreResult: enrichedStl,
      fromServerSettlement: true,
    };

    broadcast({
      type: 'game_event',
      roomId: room.id,
      seat: firstFin,
      event: finPayload,
      payload: finPayload,
      moveCount: room.moveCount,
      boardState: bs,
    });
  }

  function settleShisanshuiRound(room: any, isTimeout = false) {
    if (!room || !room.boardState) return;
    const bs = room.boardState;
    if (bs.phase === 'ended') return;

    if (!bs.shisanshuiSubmissions) bs.shisanshuiSubmissions = {};
    const totalSeats = room.players?.length || (room.sceneMode?.includes('eight') ? 8 : 4);
    const dealCards: SSSCard[][] = (room as any).deal?.seatCards || [];

    for (let s = 0; s < totalSeats; s++) {
      const sub = bs.shisanshuiSubmissions[s];
      if (!sub || !sub.tiers || !sub.rawTiers) {
        const rawHand = Array.isArray(dealCards[s]) ? dealCards[s] : [];
        const opt = autoArrangeThirteen(rawHand as SSSCard[], 'optimal');
        bs.shisanshuiSubmissions[s] = {
          seat: s,
          tiers: { head: opt.head, mid: opt.mid, tail: opt.tail },
          rawTiers: { front: opt.head, mid: opt.mid, back: opt.tail },
          isSpecial: Boolean(opt.specialHand),
          autoSubmitted: true,
          submittedAt: Date.now(),
        };
      }
    }

    const netWaters: number[] = Array(totalSeats).fill(0);
    const grandSlamSeats: boolean[] = Array(totalSeats).fill(false);
    const perSeatOppResults: Record<number, any[]> = {};

    for (let i = 0; i < totalSeats; i++) {
      const myTiers = bs.shisanshuiSubmissions[i]?.tiers;
      let totalNet = 0;
      let shotCount = 0;
      const oppCount = totalSeats - 1;
      const oppResList: any[] = [];

      for (let j = 0; j < totalSeats; j++) {
        if (i === j) continue;
        const oppTiers = bs.shisanshuiSubmissions[j]?.tiers;
        const oppPlayer = room.players?.find((p: any, idx: number) => (typeof p?.seat === 'number' ? p.seat : idx) === j);
        const oppName = oppPlayer?.name || `牌友${j + 1}`;
        const vsResult = myTiers && oppTiers
          ? compareTwoPlayers(myTiers, oppTiers, j, oppName)
          : {
              oppSeat: j,
              oppName,
              tiers: [],
              isShot: false,
              isFoulOpp: false,
              isFoulMe: false,
              rawWater: 0,
              multiplier: 1,
              finalWater: 0,
              summary: '打和 0 水',
              specialMe: undefined,
              specialOpp: undefined,
            };

        if (vsResult.isShot && vsResult.finalWater > 0) shotCount++;
        totalNet += vsResult.finalWater;
        oppResList.push({
          seat: j,
          name: oppName,
          netWater: vsResult.finalWater,
          rawWater: vsResult.rawWater,
          isShot: vsResult.isShot,
          isFoulOpp: vsResult.isFoulOpp,
          tiers: vsResult.tiers,
          summary: vsResult.summary,
          specialMe: vsResult.specialMe,
          specialOpp: vsResult.specialOpp,
        });
      }

      if (shotCount === oppCount && oppCount > 0) {
        grandSlamSeats[i] = true;
        totalNet *= 2;
        for (const res of oppResList) {
          res.netWater *= 2;
          res.summary += ' · 【触发全垒打再翻倍！】';
          if (Array.isArray(res.tiers)) {
            res.tiers.forEach((t: any) => {
              t.netWater *= 2;
              t.baseWater *= 2;
              t.bonusWater *= 2;
            });
          }
        }
      }

      netWaters[i] = totalNet;
      perSeatOppResults[i] = oppResList;
    }

    const settlementPayload = {
      netWaters,
      grandSlamSeats,
      perSeatOppResults,
    };

    bs.shisanshuiSettlement = settlementPayload;
    bs.phase = 'ended';
    room.status = 'finished';
    bs.actionSeq = (bs.actionSeq || 0) + 1;
    bs.updatedAt = Date.now();

    settleRoomCoins(
      room,
      netWaters.map((w) => w * 50),
      'shisanshui',
      { ratingDeltaBySeat: netWaters.map((w) => Math.round(w * 2.5)) }
    );

    resetSceneRoomReadyAndCleanDisconnected(room.id);

    const allSubEvt = {
      action: 'shisanshui_all_submitted',
      submissions: bs.shisanshuiSubmissions,
      settlement: settlementPayload,
      timeout: isTimeout || undefined,
    };

    broadcast({
      type: 'game_event',
      roomId: room.id,
      event: allSubEvt,
      payload: allSubEvt,
      boardState: bs,
    });
  }

  function startRoomGameIfFull(room: SceneWaitingRoom) {
    if (!room) return false;

    if (!Array.isArray(room.players) || room.players.length < room.maxPlayers) {
      if (room.status !== 'waiting') {
        room.status = 'waiting';
        delete (room as any).deal;
      }
      return false;
    }

    if ((room.status === 'starting' || room.status === 'playing') && (room as any).deal && (room as any).deal.seatCards) {
      return true;
    }

    const validPlayers = room.players.filter((p: any) => p && (p.id || p.name)).slice(0, room.maxPlayers);
    if (validPlayers.length < room.maxPlayers) {
      room.status = 'waiting';
      return false;
    }

    validPlayers.forEach((pl: any, idx: number) => {
      pl.seat = idx;
      // 关键修复：一旦达成满员开局，立即将非机器人真人玩家 isReady 归零，杜绝下一局客户端出现“所有玩家已准备”假死锁！
      pl.isReady = isBotLikePlayer(pl);
      delete (pl as any).isDisconnected;
      delete (pl as any).isAutoManaged;
      if (!pl.id) pl.id = `P-usr-${idx}-${Date.now().toString(36)}`;
      if (!pl.name) pl.name = `茶客 #${idx + 1}`;
    });
    room.players = validPlayers;
    room.status = 'starting';
    delete (room as any).settlementExpiresAt;
    room.roundIndex = (room.roundIndex || 0) + 1;

    delete (room as any).deal;
    const freshDeal: any = generateRoomDeal(room.gameType, room.sceneMode, room.maxPlayers);
    if (!freshDeal.dealId) {
      freshDeal.dealId = `${room.gameType}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    }
    if (room.gameType === 'yansan' && Array.isArray(freshDeal.seatCards)) {
      freshDeal.initialSeatCards = freshDeal.seatCards.map((hand: any[]) => [...hand]);
    }
    (room as any).deal = freshDeal;

    const defaultBoard = createDefaultBoardState(room.id, room.gameType);
    if (room.gameType === 'yansan') {
      defaultBoard.extraState.hasPassedSeats = [false, false, false, false];
      defaultBoard.extraState.seatPlayedCards = [[], [], [], []];
      defaultBoard.extraState.playHistory = [];
      defaultBoard.extraState.isQiangGongActive = false;
      defaultBoard.extraState.qiangGongSeat = null;
    }
    if (room.gameType === 'mahjong') {
      defaultBoard.extraState.claimWindow = null;
      defaultBoard.extraState.wallRemaining = Array.isArray(freshDeal.remainingWall) ? freshDeal.remainingWall.length : 83;
      const dSeat = typeof freshDeal.dealerSeat === 'number' ? freshDeal.dealerSeat : 0;
      defaultBoard.turnSeat = dSeat;
      defaultBoard.handsCount = [0, 1, 2, 3].map((s) =>
        Array.isArray(freshDeal.seatCards?.[s]) ? freshDeal.seatCards[s].length : (s === dSeat ? 14 : 13)
      );
    }

    if (!rooms.has(room.id)) {
      rooms.set(room.id, {
        id: room.id,
        title: `${room.sceneName} · 纯真人对决`,
        gameType: room.gameType,
        status: 'starting',
        players: room.players.map((pl, idx) => ({ ...pl, seat: idx, rating: pl.rating || 1900 })),
        spectators: 0,
        turnSeat: freshDeal?.starterSeat ?? 0,
        lastTurnTs: Date.now(),
        moveCount: 0,
        roundIndex: room.roundIndex,
        deal: freshDeal,
        modeLabel: `${room.sceneName} · 实时对决`,
        chat: [],
        boardState: defaultBoard,
      });
    } else {
      const existingRoom = rooms.get(room.id);
      if (existingRoom) {
        existingRoom.status = 'starting';
        delete existingRoom.settlementExpiresAt;
        existingRoom.moveCount = 0;
        existingRoom.roundIndex = room.roundIndex;
        existingRoom._coinsSettledRoundKey = undefined;
        existingRoom.deal = freshDeal;
        existingRoom.turnSeat = freshDeal?.starterSeat ?? 0;
        existingRoom.lastTurnTs = Date.now();
        existingRoom.boardState = defaultBoard;
        existingRoom.players = room.players.map((pl, idx) => ({ ...pl, seat: idx, rating: pl.rating || 1900 }));
      }
    }

    if ((room as any)._startTimer) {
      clearTimeout((room as any)._startTimer);
      (room as any)._startTimer = null;
    }

    console.log(
      `🚀 [满员自动发牌] 房间 ${room.id} (${room.gameType}-${room.sceneMode}) ${room.players.length}/${room.maxPlayers} 玩家席位校验完毕，定向脱敏广播 scene_room_full！`
    );

    sendSanitizedToRoom(room, (seat) => ({
      type: 'scene_room_full',
      roomId: room.id,
      gameType: room.gameType,
      sceneMode: room.sceneMode,
      players: room.players,
      maxPlayers: room.maxPlayers,
      deal: sanitizeDealForSeat(room.gameType, freshDeal, seat),
      turnSeat: freshDeal?.starterSeat ?? 0,
      boardState: defaultBoard,
      status: 'starting',
      lockGameLaunch: true,
      forceReset: true,
      timestamp: Date.now(),
    }));

    (room as any)._startTimer = setTimeout(() => {
      (room as any)._startTimer = null;
      if (room && sceneWaitingRooms.has(room.id) && (room as any).deal === freshDeal) {
        room.status = 'playing';
        room.players.forEach((p: any) => {
          p.isReady = isBotLikePlayer(p);
        });
        const authRoom = rooms.get(room.id);
        if (authRoom) {
          authRoom.status = 'playing';
          authRoom.lastTurnTs = Date.now();
          authRoom.players?.forEach((p: any) => {
            p.isReady = isBotLikePlayer(p);
          });
        }
        sendSanitizedToRoom(room, (seat) => ({
          type: 'scene_room_started',
          roomId: room.id,
          gameType: room.gameType,
          sceneMode: room.sceneMode,
          players: room.players,
          maxPlayers: room.maxPlayers,
          deal: sanitizeDealForSeat(room.gameType, freshDeal, seat),
          turnSeat: freshDeal?.starterSeat ?? 0,
          boardState: authRoom ? authRoom.boardState : defaultBoard,
          status: 'playing',
          lockGameLaunch: true,
          forceReset: true,
          timestamp: Date.now(),
        }));
      }
    }, 1400);

    return true;
  }

  wss.on('connection', (ws, req) => {
    try {
      (ws as any)?._socket?.setNoDelay?.(true);
      (req?.socket as any)?.setNoDelay?.(true);
    } catch {}
    const socketId = Math.random().toString(36).slice(2, 10);
    (ws as any).socketId = socketId;
    (ws as any).isAlive = true;
    (ws as any).lastHeartbeat = Date.now();
    presenceTracker.recordClient(socketId, { gameType: 'lobby' });

    ws.on('pong', () => {
      (ws as any).isAlive = true;
      (ws as any).lastHeartbeat = Date.now();
    });

    ws.on('error', () => {
      // Gracefully ignore client connection reset
    });

    try {
      const presenceCounts = presenceTracker.getRealGamePresence();
      const db = loadDatabase();
      const teahousePlayers = presenceTracker.getAllPlayers(db.profiles || {});
      ws.send(
        JSON.stringify({
          type: 'lobby_snapshot',
          rooms: Array.from(rooms.values()).map((r) => {
            const { deal: _d, ...rest } = r;
            return rest;
          }),
          onlineCount: wss.clients.size,
          counts: presenceCounts,
          players: teahousePlayers,
          serverTs: Date.now(),
        })
      );
      ws.send(
        JSON.stringify({
          type: 'teahouse_players_update',
          count: teahousePlayers.length,
          onlineCount: teahousePlayers.filter((p: any) => p.isOnline).length,
          players: teahousePlayers,
        })
      );
    } catch {}

    broadcast({
      type: 'presence_counts',
      counts: presenceTracker.getRealGamePresence(),
    });
    broadcastTeahousePlayers();

    ws.on('close', () => {
      presenceTracker.removeClient((ws as any).socketId);
      broadcastTeahousePlayers();
      const sRoomId = (ws as any).sceneRoomId;
      const pId = (ws as any).scenePlayerId;
      let room = sRoomId ? sceneWaitingRooms.get(sRoomId) : undefined;
      if (!room && sRoomId) {
        room = rooms.get(sRoomId) as any;
      }
      if (sRoomId && room) {
        const isShisanshuiReservation = room.gameType === 'shisanshui' && room.sceneMode === 'reservation';

        if (room.status === 'finished' && !isShisanshuiReservation) {
          // 结算界面期间断线/刷新页面：保留席位与结算快照，直到玩家点击继续下一局、主动退出大厅或结算超时
          const pl = room.players.find(
            (p: any) => p.socketId === (ws as any).socketId || (pId && (p.id === pId || (p as any).originalId === pId))
          );
          if (pl) {
            (pl as any).isDisconnected = true;
            delete (pl as any).socketId;
          }
          const authRoom = rooms.get(sRoomId);
          if (authRoom) {
            const aPl = (authRoom.players || []).find(
              (p: any) => p.socketId === (ws as any).socketId || (pl && p.id === pl.id) || (pId && (p.id === pId || p.originalId === pId))
            );
            if (aPl) {
              (aPl as any).isDisconnected = true;
              delete (aPl as any).socketId;
            }
          }
        } else if ((room.status === 'starting' || room.status === 'playing') && !isShisanshuiReservation) {
          const pl = room.players.find(
            (p: any) => p.socketId === (ws as any).socketId || p.id === pId
          );
          if (pl) {
            const plSeat = pl.seat;
            (pl as any).isDisconnected = true;
            (pl as any).isAutoManaged = true;

            const authRoom = rooms.get(sRoomId);
            if (authRoom) {
              const aPl = (authRoom.players || []).find(
                (p: any) => p.socketId === (ws as any).socketId || p.id === pl.id
              );
              if (aPl) {
                (aPl as any).isDisconnected = true;
                (aPl as any).isAutoManaged = true;
              }
              if (!authRoom.boardState) {
                authRoom.boardState = createDefaultBoardState(authRoom.id, authRoom.gameType);
              }
              if (!authRoom.boardState.autoManagedSeats) authRoom.boardState.autoManagedSeats = {};
              authRoom.boardState.autoManagedSeats[plSeat] = true;
              if (authRoom.turnSeat === plSeat) {
                authRoom.lastTurnTs = Date.now() - 2000;
              }
            }

            console.log(`🤖 [断线自动托管] 玩家 ${pl.name} (${pl.id}) 席位 ${plSeat} 掉线，已启用智能托管完成该局对局`);
            broadcast({
              type: 'scene_room_update',
              roomId: room.id,
              gameType: room.gameType,
              sceneMode: room.sceneMode,
              players: room.players,
              maxPlayers: room.maxPlayers,
              status: room.status,
            });
            broadcast({
              type: 'game_event',
              roomId: room.id,
              seat: plSeat,
              event: {
                action: 'set_auto_host',
                seat: plSeat,
                absSeat: plSeat,
                isAutoManaged: true,
                isAutoHost: true,
                isDisconnected: true,
                playerName: pl.name,
              },
              payload: {
                action: 'set_auto_host',
                seat: plSeat,
                absSeat: plSeat,
                isAutoManaged: true,
                isAutoHost: true,
                isDisconnected: true,
                playerName: pl.name,
              },
              boardState: authRoom ? authRoom.boardState : (room as any).boardState,
            });
          }
        } else {
          room.players = room.players.filter(
            (pl: any) => pl.id !== pId && pl.socketId !== (ws as any).socketId
          );
          if (room.players.length === 0) {
            sceneWaitingRooms.delete(sRoomId);
          } else {
            room.players.forEach((pl: any, idx: number) => {
              pl.seat = idx;
            });
            if (room.status !== 'playing' && room.status !== 'starting') {
              room.status = 'waiting';
            }
            broadcast({
              type: 'scene_room_update',
              roomId: room.id,
              gameType: room.gameType,
              sceneMode: room.sceneMode,
              players: room.players,
              maxPlayers: room.maxPlayers,
              status: room.status,
            });
          }
        }
      }
      for (let i = activeChallenges.length - 1; i >= 0; i--) {
        const ch = activeChallenges[i];
        if (ch.senderId === pId && !ch.acceptedBy) {
          const rmId = ch.id;
          activeChallenges.splice(i, 1);
          broadcast({
            type: 'challenge_status_update',
            challengeId: rmId,
            status: 'removed',
            senderId: pId,
            senderName: ch.senderName,
            gameType: ch.gameType,
            sceneMode: ch.sceneMode,
          });
        }
      }
      broadcast({
        type: 'presence_counts',
        counts: presenceTracker.getRealGamePresence(),
      });
    });

    ws.on('message', async (data) => {
      try {
        (ws as any).isAlive = true;
        (ws as any).lastHeartbeat = Date.now();
        const msg = JSON.parse(data.toString());

        if (msg.type === 'ping') {
          ws.send(
            JSON.stringify({
              type: 'pong',
              clientTs: msg.clientTs,
              serverTs: Date.now(),
              onlineCount: wss.clients.size,
            })
          );
          return;
        }

        if (msg.type === 'presence_update') {
          const targetGame =
            msg.gameType === 'yansan' || msg.gameType === 'shisanshui' || msg.gameType === 'mahjong'
              ? msg.gameType
              : 'lobby';
          if ('sessionToken' in msg) {
            let authed = false;
            if (msg.sessionToken && msg.playerId) {
              try {
                const db = loadDatabase();
                const prof = db.profiles?.[msg.playerId];
                if (prof && prof.sessionToken && prof.sessionToken === msg.sessionToken && !prof.isBanned) {
                  (ws as any).authenticatedUserId = prof.id;
                  (ws as any).userId = prof.id;
                  authed = true;
                }
              } catch {}
            }
            if (!authed) {
              delete (ws as any).authenticatedUserId;
              (ws as any).userId = msg.playerId || undefined;
            }
          }
          presenceTracker.updateClientGame((ws as any).socketId, targetGame, msg.sceneMode);
          if (msg.playerId) {
            presenceTracker.recordClient((ws as any).socketId, {
              gameType: targetGame,
              playerId: msg.playerId,
              playerName: msg.playerName,
              avatar: msg.avatar,
              coins: typeof msg.coins === 'number' ? msg.coins : undefined,
              rating: typeof msg.rating === 'number' ? msg.rating : undefined,
              phone: msg.phone,
              sceneMode: msg.sceneMode,
            });
          }
          broadcast({
            type: 'presence_counts',
            counts: presenceTracker.getRealGamePresence(),
          });
          broadcastTeahousePlayers();
          return;
        }

        if (msg.type === 'request_teahouse_players') {
          const db = loadDatabase();
          const players = presenceTracker.getAllPlayers(db.profiles || {});
          ws.send(
            JSON.stringify({
              type: 'teahouse_players_update',
              count: players.length,
              onlineCount: players.filter((p: any) => p.isOnline).length,
              players,
            })
          );
          return;
        }

        const resolveBookingUserId = (rawId?: string, token?: string): { ok: boolean; userId: string; error?: string } => {
          const uid = rawId || (ws as any).authenticatedUserId || (ws as any).userId || 'guest';
          const db = loadDatabase();
          if (token && uid) {
            const prof = db.profiles?.[uid];
            if (prof && prof.sessionToken && prof.sessionToken === token && !prof.isBanned) {
              (ws as any).authenticatedUserId = prof.id;
              return { ok: true, userId: prof.id };
            }
          }
          if (uid && db.profiles?.[uid]?.password && (ws as any).authenticatedUserId !== uid) {
            return { ok: false, userId: uid, error: '账号会话校验未通过，请重新登录或刷新重连' };
          }
          return { ok: true, userId: (ws as any).authenticatedUserId || uid };
        };

        // 预约场火车专列权威同步（多端一致性、实时占座、13张防作弊校验、模拟与06:00真实入账）
        if (msg.type === 'booking_get_carriage') {
          const sceneMode = msg.sceneMode === 'eight-booking' ? 'eight-booking' : 'four-booking';
          const authCheck = resolveBookingUserId(msg.playerId || msg.userId, msg.sessionToken);
          if (!authCheck.ok) {
            ws.send(JSON.stringify({ type: 'booking_error', action: 'get_carriage', error: authCheck.error, serverTs: Date.now() }));
            return;
          }
          const userId = authCheck.userId;
          const state = await getServerBookingState({
            sceneMode,
            userId,
            playerName: msg.playerName || '茶客',
            avatar: msg.avatar || '👑',
            requestedCarriageId: msg.carriageId || undefined,
            requestedCarriageNumber: msg.carriageNumber ? Number(msg.carriageNumber) : undefined,
          });
          if (state.settledNotifications?.length) {
            emitBookingSettlementNotifications(state.settledNotifications);
          }
          ws.send(
            JSON.stringify({
              type: 'booking_carriage_state',
              sceneMode,
              carriage: state.carriage,
              archivedCarriages: state.archivedCarriages,
              settlementHistory: state.settlementHistory,
              unreadSettlements: state.unreadSettlements,
              serverTs: Date.now(),
            })
          );
          return;
        }

        if (msg.type === 'booking_select_seat') {
          const sceneMode = msg.sceneMode === 'eight-booking' ? 'eight-booking' : 'four-booking';
          const authCheck = resolveBookingUserId(msg.playerId || msg.userId, msg.sessionToken);
          if (!authCheck.ok) {
            ws.send(JSON.stringify({ type: 'booking_error', action: 'select_seat', error: authCheck.error, serverTs: Date.now() }));
            return;
          }
          const userId = authCheck.userId;
          const res = await selectServerBookingSeat({
            sceneMode,
            userId,
            playerName: msg.playerName || '茶客',
            avatar: msg.avatar || '👑',
            seat: msg.seat || '东',
            carriageId: msg.carriageId || undefined,
            carriageNumber: msg.carriageNumber ? Number(msg.carriageNumber) : undefined,
          });
          if (!res.ok) {
            ws.send(
              JSON.stringify({
                type: 'booking_error',
                action: 'select_seat',
                error: res.error,
                carriage: (res as any).carriage || null,
                serverTs: Date.now(),
              })
            );
            return;
          }
          ws.send(
            JSON.stringify({
              type: 'booking_seat_selected',
              sceneMode,
              carriage: res.carriage,
              archivedCarriages: res.archivedCarriages,
              activeTableIndex: res.carriage.currentActiveTableIndex,
              serverTs: Date.now(),
            })
          );
          broadcast({
            type: 'booking_carriage_occupants_updated',
            sceneMode,
            carriageId: res.carriageId,
            carriageNumber: res.carriageNumber,
            seatOccupants: res.rawSeatOccupants,
          });
          return;
        }

        if (msg.type === 'booking_pick_table') {
          const sceneMode = msg.sceneMode === 'eight-booking' ? 'eight-booking' : 'four-booking';
          const authCheck = resolveBookingUserId(msg.playerId || msg.userId, msg.sessionToken);
          if (!authCheck.ok) {
            ws.send(JSON.stringify({ type: 'booking_error', action: 'pick_table', error: authCheck.error, serverTs: Date.now() }));
            return;
          }
          const userId = authCheck.userId;
          const res = await pickServerBookingTable({
            sceneMode,
            userId,
            carriageId: msg.carriageId || undefined,
            carriageNumber: msg.carriageNumber ? Number(msg.carriageNumber) : undefined,
            specificTableIndex: msg.tableIndex ? Number(msg.tableIndex) : undefined,
          });
          if (!res.ok) {
            ws.send(
              JSON.stringify({
                type: 'booking_error',
                action: 'pick_table',
                error: res.error,
                serverTs: Date.now(),
              })
            );
            return;
          }
          ws.send(
            JSON.stringify({
              type: 'booking_table_picked',
              sceneMode,
              carriage: res.carriage,
              archivedCarriages: res.archivedCarriages,
              activeTableIndex: res.carriage.currentActiveTableIndex,
              serverTs: Date.now(),
            })
          );
          return;
        }

        if (msg.type === 'booking_submit_hand' || msg.type === 'booking_submit') {
          const sceneMode = msg.sceneMode === 'eight-booking' ? 'eight-booking' : 'four-booking';
          const authCheck = resolveBookingUserId(msg.playerId || msg.userId, msg.sessionToken);
          if (!authCheck.ok) {
            ws.send(JSON.stringify({ type: 'booking_error', action: 'submit_hand', error: authCheck.error, serverTs: Date.now() }));
            return;
          }
          const userId = authCheck.userId;
          const res = await submitServerBookingHand({
            sceneMode,
            userId,
            playerName: msg.playerName || '茶客',
            avatar: msg.avatar || '👑',
            carriageId: msg.carriageId || undefined,
            carriageNumber: msg.carriageNumber ? Number(msg.carriageNumber) : undefined,
            tableIndex: msg.tableIndex ? Number(msg.tableIndex) : undefined,
            playerSeat: msg.playerSeat,
            handTiers: msg.playerHand,
            isGraceSubmission: Boolean(msg.isGraceSubmission),
          });
          if (!res.ok) {
            ws.send(
              JSON.stringify({
                type: 'booking_error',
                action: 'submit_hand',
                error: res.error,
                serverTs: Date.now(),
              })
            );
            return;
          }
          if (res.settledNotifications?.length) {
            emitBookingSettlementNotifications(res.settledNotifications);
          }
          ws.send(
            JSON.stringify({
              type: 'booking_submit_ack',
              success: true,
              sceneMode,
              carriage: res.carriage,
              submittedTable: res.submittedTable,
              remainingCount: res.remainingCount,
              isCarriageCompleted: res.isCarriageCompleted,
              archivedCarriages: res.archivedCarriages,
              settlementHistory: res.settlementHistory,
              serverTs: Date.now(),
            })
          );
          broadcast({
            type: 'booking_carriage_occupants_updated',
            sceneMode,
            carriageId: res.carriageId,
            carriageNumber: res.carriageNumber,
            tableIndex: res.tableIndex,
            seat: res.seat,
            seatOccupants: res.seatOccupants,
          });
          return;
        }

        if (msg.type === 'booking_advance_carriage') {
          const sceneMode = msg.sceneMode === 'eight-booking' ? 'eight-booking' : 'four-booking';
          const authCheck = resolveBookingUserId(msg.playerId || msg.userId, msg.sessionToken);
          if (!authCheck.ok) {
            ws.send(JSON.stringify({ type: 'booking_error', action: 'advance_carriage', error: authCheck.error, serverTs: Date.now() }));
            return;
          }
          const userId = authCheck.userId;
          const res = await advanceServerBookingCarriage({
            sceneMode,
            userId,
            playerName: msg.playerName || '茶客',
            avatar: msg.avatar || '👑',
            createFresh: Boolean(msg.createFresh),
          });
          ws.send(
            JSON.stringify({
              type: 'booking_carriage_advanced',
              sceneMode,
              carriage: res.carriage,
              archivedCarriages: res.archivedCarriages,
              serverTs: Date.now(),
            })
          );
          if (res.releasedSeatInfo) {
            broadcast({
              type: 'booking_carriage_occupants_updated',
              sceneMode,
              carriageId: res.releasedSeatInfo.carriageId,
              carriageNumber: res.releasedSeatInfo.carriageNumber,
              seatOccupants: res.releasedSeatInfo.seatOccupants,
            });
          }
          return;
        }

        if (msg.type === 'booking_simulate_settle') {
          const sceneMode = msg.sceneMode === 'eight-booking' ? 'eight-booking' : 'four-booking';
          const authCheck = resolveBookingUserId(msg.playerId || msg.userId, msg.sessionToken);
          if (!authCheck.ok) {
            ws.send(JSON.stringify({ type: 'booking_error', action: 'simulate_settle', error: authCheck.error, serverTs: Date.now() }));
            return;
          }
          const userId = authCheck.userId;
          const res = await simulateServerBookingSettlement({
            sceneMode,
            userId,
            carriageId: msg.carriageId || undefined,
            carriageNumber: msg.carriageNumber ? Number(msg.carriageNumber) : undefined,
          });
          if (!res.ok) {
            ws.send(
              JSON.stringify({
                type: 'booking_error',
                action: 'simulate_settle',
                error: res.error,
                serverTs: Date.now(),
              })
            );
            return;
          }
          ws.send(
            JSON.stringify({
              type: 'booking_simulation_result',
              sceneMode,
              record: res.record,
              carriage: res.carriage,
              archivedCarriages: res.archivedCarriages,
              serverTs: Date.now(),
            })
          );
          return;
        }

        if (msg.type === 'booking_settle_0600') {
          const userId = msg.playerId || msg.userId;
          const notifications = await runServer0600SettlementSweep({
            onlyUserId: userId || undefined,
            forceIncludeGraceForUserId: msg.forceIncludeGrace ? userId : undefined,
          });
          if (notifications.length > 0) {
            emitBookingSettlementNotifications(notifications);
          }
          if (userId) {
            const sceneMode = msg.sceneMode === 'eight-booking' ? 'eight-booking' : 'four-booking';
            const refreshed = await getServerBookingState({
              sceneMode,
              userId,
              requestedCarriageId: msg.carriageId || undefined,
              requestedCarriageNumber: msg.carriageNumber ? Number(msg.carriageNumber) : undefined,
            });
            ws.send(
              JSON.stringify({
                type: 'booking_carriage_state',
                sceneMode,
                carriage: refreshed.carriage,
                archivedCarriages: refreshed.archivedCarriages,
                settlementHistory: refreshed.settlementHistory,
                unreadSettlements: refreshed.unreadSettlements,
                serverTs: Date.now(),
              })
            );
          }
          return;
        }

        if (msg.type === 'booking_ack_settlement') {
          const userId = msg.playerId || msg.userId;
          if (userId) {
            await ackServerUnreadSettlements(userId);
          }
          return;
        }

        // 局内断线快照恢复
        if (msg.type === 'scene_reconnect') {
          const pId = msg.playerId;
          const targetRoomId = msg.roomId;
          let targetRoom: SceneWaitingRoom | undefined;
          if (targetRoomId && sceneWaitingRooms.has(targetRoomId)) {
            targetRoom = sceneWaitingRooms.get(targetRoomId);
          }
          if (!targetRoom && pId) {
            for (const r of sceneWaitingRooms.values()) {
              if (r.players.some((pl) => pl.id === pId || (pl as any).originalId === pId || (pl as any).userId === pId)) {
                targetRoom = r;
                break;
              }
            }
            if (!targetRoom && msg.playerName) {
              for (const r of sceneWaitingRooms.values()) {
                if (r.players.some((pl) => pl.name === msg.playerName)) {
                  targetRoom = r;
                  break;
                }
              }
            }
          }
          if (targetRoom) {
            const pl =
              targetRoom.players.find((p) => (pId && (p.id === pId || (p as any).originalId === pId || (p as any).userId === pId))) ||
              (msg.playerName ? targetRoom.players.find((p) => p.name === msg.playerName) : undefined);
            if (pl) {
              const authRoom = rooms.get(targetRoom.id);
              const isFinishedPhase = targetRoom.status === 'finished' || authRoom?.boardState?.phase === 'ended';
              if (isFinishedPhase) {
                targetRoom.status = 'finished';
              }
              delete (pl as any).isDisconnected;
              if (!isFinishedPhase) {
                delete (pl as any).isAutoManaged;
              }
              (pl as any).socketId = (ws as any).socketId;
              (ws as any).sceneRoomId = targetRoom.id;
              (ws as any).scenePlayerId = pl.id;
              if (authRoom) {
                const aPl =
                  (authRoom.players || []).find((p: any) => p.id === pl.id || (pId && (p.id === pId || p.originalId === pId || p.userId === pId))) ||
                  (msg.playerName ? (authRoom.players || []).find((p: any) => p.name === msg.playerName) : undefined);
                if (aPl) {
                  delete (aPl as any).isDisconnected;
                  if (!isFinishedPhase) {
                    delete (aPl as any).isAutoManaged;
                  }
                  aPl.socketId = (ws as any).socketId;
                }
                if (!isFinishedPhase && authRoom.boardState?.autoManagedSeats && typeof pl.seat === 'number') {
                  delete authRoom.boardState.autoManagedSeats[pl.seat];
                }
              }
              const rawDeal = (authRoom ? (authRoom as any).deal : null) || (targetRoom as any).deal || null;
              const settlementExpiresAt =
                (authRoom as any)?.settlementExpiresAt ||
                (targetRoom as any)?.settlementExpiresAt ||
                authRoom?.boardState?.settlement?.settlementExpiresAt ||
                null;
              const nowTs = Date.now();
              ws.send(
                JSON.stringify({
                  type: 'scene_reconnect_ack',
                  room: targetRoom,
                  boardState: sanitizeBoardStateForSeat(authRoom ? authRoom.boardState : null, targetRoom.gameType, pl.seat),
                  players: targetRoom.players,
                  deal: rawDeal ? sanitizeDealForSeat(targetRoom.gameType, rawDeal, pl.seat) : null,
                  settlementExpiresAt,
                  serverTs: nowTs,
                })
              );
              broadcast({
                type: 'scene_room_update',
                roomId: targetRoom.id,
                gameType: targetRoom.gameType,
                sceneMode: targetRoom.sceneMode,
                players: targetRoom.players,
                maxPlayers: targetRoom.maxPlayers,
                status: targetRoom.status,
                settlementExpiresAt,
                serverTs: nowTs,
              });
              if (!isFinishedPhase) {
                broadcast({
                  type: 'game_event',
                  roomId: targetRoom.id,
                  seat: pl.seat,
                  event: {
                    action: 'set_auto_host',
                    seat: pl.seat,
                    absSeat: pl.seat,
                    isAutoManaged: false,
                    isAutoHost: false,
                    isDisconnected: false,
                  },
                  payload: {
                    action: 'set_auto_host',
                    seat: pl.seat,
                    absSeat: pl.seat,
                    isAutoManaged: false,
                    isAutoHost: false,
                    isDisconnected: false,
                  },
                  boardState: authRoom ? authRoom.boardState : null,
                });
              }
              return;
            }
          }
          ws.send(
            JSON.stringify({
              type: 'scene_reconnect_ack',
              failed: true,
              reason: 'room_not_found',
            })
          );
          return;
        }

        if (msg.type === 'scene_player_ready' || msg.type === 'room_restart') {
          const targetRoomId = msg.roomId || (ws as any).sceneRoomId;
          const pId = msg.playerId || (ws as any).scenePlayerId;
          let room: SceneWaitingRoom | undefined;
          if (targetRoomId && sceneWaitingRooms.has(targetRoomId)) {
            room = sceneWaitingRooms.get(targetRoomId);
          }
          if (!room) {
            for (const r of sceneWaitingRooms.values()) {
              if (
                r.players.some(
                  (pl) =>
                    (pl as any).socketId === (ws as any).socketId ||
                    (pl.id && pId && (pl.id === pId || pl.originalId === pId || (pl as any).userId === pId))
                )
              ) {
                room = r;
                break;
              }
            }
          }
          if (room) {
            const authRoom = rooms.get(room.id);
            if (authRoom && (authRoom.boardState?.phase === 'ended' || authRoom.status === 'finished')) {
              room.status = 'finished';
            }
            if (room.status === 'starting' || room.status === 'playing') {
              return;
            }
            // socketId 优先精确匹配，杜绝多标签或同前辍玩家互相误改准备标志
            let pl = room.players.find((p) => (p as any).socketId && (p as any).socketId === (ws as any).socketId);
            if (!pl && pId) {
              pl = room.players.find((p) => p.id === pId || p.originalId === pId || (p as any).userId === pId);
            }
            if (!pl && msg.playerName) {
              pl = room.players.find((p) => p.name === msg.playerName);
            }
            if (pl) {
              (pl as any).socketId = (ws as any).socketId;
              (pl as any).isReady = Boolean(msg.isReady ?? true);
              if (authRoom?.players) {
                const aPl = authRoom.players.find((ap: any) => ap.id === pl!.id || (pId && (ap.id === pId || ap.originalId === pId)));
                if (aPl) aPl.isReady = (pl as any).isReady;
              }
            }
            room.players.forEach((p: any) => {
              if (isBotLikePlayer(p)) {
                p.isReady = true;
              }
            });

            const readyCount = room.players.filter((p: any) => p.isReady).length;
            console.log(`🎮 [联机准备] 房间 ${room.id} (${room.gameType}) 玩家准备进度: ${readyCount}/${room.maxPlayers}`);

            const allFullReady = room.players.length >= room.maxPlayers && room.players.every((p: any) => p.isReady);
            if (allFullReady) {
              console.log(`🚀 [全员就绪再开] 房间 ${room.id} (${readyCount}/${room.maxPlayers}) 全员准备完成，生成全新发牌切片开启下一局！`);
              room.status = 'waiting';
              delete (room as any).deal;
              delete (room as any).settlementExpiresAt;
              if (authRoom) delete authRoom.settlementExpiresAt;
              startRoomGameIfFull(room);
              return;
            }

            // 若已有其他牌友离开导致人数不足，保持当前 finished 结算视图与已准备人数同步，待新牌友加入满员自动开下一局
            broadcast({
              type: 'scene_room_update',
              roomId: room.id,
              gameType: room.gameType,
              sceneMode: room.sceneMode,
              players: room.players,
              maxPlayers: room.maxPlayers,
              status: room.status,
              settlementExpiresAt: (room as any).settlementExpiresAt || (authRoom as any)?.settlementExpiresAt || null,
              serverTs: Date.now(),
            });
            return;
          }
          if (msg.type === 'scene_player_ready') {
            return;
          }
        }

        if (msg.type === 'scene_start_game') {
          const roomId = msg.roomId;
          if (roomId && sceneWaitingRooms.has(roomId)) {
            const room = sceneWaitingRooms.get(roomId)!;
            startRoomGameIfFull(room);
          }
          return;
        }

        if (msg.type === 'scene_fill_bots' || msg.type === 'scene_quick_match') {
          console.warn(`⛔ [纯真人防假人] 拦截人机补位请求 (${msg.type})，当前房间为真实玩家匹配房间，严禁人机补位！`);
          return;
        }

        if (msg.type === 'scene_join') {
          const gType = msg.gameType || 'yansan';
          const sMode = msg.sceneMode || 'standard';
          const sName = msg.sceneName || '经典场';
          const maxP = Number(msg.maxPlayers) || (gType === 'shisanshui' && sMode.includes('eight') ? 8 : 4);
          const p: ScenePlayer = msg.player || {
            id: `P-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            name: '牌友',
            avatar: '👑',
            rating: 1900,
            coins: 2000,
            seat: 0,
          };

          const rawId = p.id;
          if (!p.id || p.id === 'P-me' || p.id === 'P-123') {
            p.id = `P-usr-${(ws as any).socketId || Date.now()}`;
            (p as any).originalId = rawId || 'P-me';
          }
          delete (p as any).isSimulated;
          delete (p as any).isAi;

          const reqCoins = getSceneRequiredCoins(gType, sMode);
          const currentCoins = typeof p.coins === 'number' && !isNaN(p.coins) ? p.coins : 0;
          if (currentCoins < reqCoins || currentCoins <= 0) {
            ws.send(
              JSON.stringify({
                type: 'scene_join_rejected',
                reason: 'insufficient_coins',
                requiredCoins: reqCoins,
                currentCoins,
                text: `您的积分不足 (${currentCoins}/${reqCoins} 分)，无法入座此分场！`,
              })
            );
            return;
          }

          const currentSocketId = (ws as any).socketId;
          for (const [otherId, otherRoom] of sceneWaitingRooms.entries()) {
            const isPlayerInOther = otherRoom.players.some(
              (pl) => (pl.id && p.id && pl.id === p.id) || (pl as any).socketId === currentSocketId
            );
            if (isPlayerInOther && (otherRoom.gameType !== gType || otherRoom.sceneMode !== sMode)) {
              if (otherRoom.status === 'playing' || otherRoom.status === 'starting') {
                const matchedOld = otherRoom.players.find(
                  (pl) => (pl.id && p.id && pl.id === p.id) || (pl as any).socketId === currentSocketId
                );
                if (matchedOld) {
                  matchedOld.isDisconnected = true;
                  matchedOld.isAutoManaged = true;
                }
              } else {
                otherRoom.players = otherRoom.players.filter(
                  (pl) => pl.id !== p.id && (pl as any).socketId !== currentSocketId
                );
                if (otherRoom.players.length === 0) {
                  sceneWaitingRooms.delete(otherId);
                } else {
                  otherRoom.players.forEach((pl, idx) => {
                    pl.seat = idx;
                  });
                  if (otherRoom.status === 'waiting') {
                    broadcast({
                      type: 'scene_room_update',
                      roomId: otherRoom.id,
                      gameType: otherRoom.gameType,
                      sceneMode: otherRoom.sceneMode,
                      players: otherRoom.players,
                      maxPlayers: otherRoom.maxPlayers,
                      status: otherRoom.status,
                    });
                  }
                }
              }
            }
          }

          let room: SceneWaitingRoom | undefined;
          for (const r of sceneWaitingRooms.values()) {
            if (r.gameType === gType && r.sceneMode === sMode) {
              if (r.players.some((pl) => (pl as any).socketId === currentSocketId)) {
                room = r;
                break;
              }
            }
          }

          if (!room && p.id) {
            for (const r of sceneWaitingRooms.values()) {
              if (r.gameType === gType && r.sceneMode === sMode && (r.status === 'waiting' || r.status === 'finished')) {
                const matchedPlayer = r.players.find((pl) => pl.id === p.id);
                if (matchedPlayer) {
                  let oldSocketAlive = false;
                  for (const client of wss.clients) {
                    if ((client as any).socketId === (matchedPlayer as any).socketId && client.readyState === WebSocket.OPEN) {
                      oldSocketAlive = true;
                      break;
                    }
                  }
                  if (!oldSocketAlive && r.players.length < r.maxPlayers) {
                    room = r;
                    break;
                  }
                }
              }
            }
          }

          if (!room) {
            for (const r of sceneWaitingRooms.values()) {
              if (
                r.gameType === gType &&
                r.sceneMode === sMode &&
                r.players.length < r.maxPlayers &&
                (r.status === 'waiting' || (r.status === 'finished' && r.players.length > 0 && r.players.every((pl: any) => pl.isReady)))
              ) {
                room = r;
                break;
              }
            }
          }

          if (!room) {
            const id = `SCENE-${gType}-${sMode}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            room = {
              id,
              gameType: gType,
              sceneMode: sMode,
              sceneName: sName,
              maxPlayers: maxP,
              players: [],
              status: 'waiting',
              createdAt: Date.now(),
            };
            sceneWaitingRooms.set(id, room);
          }

          let existingIdx = room.players.findIndex((pl) => (pl as any).socketId === currentSocketId);
          if (existingIdx === -1 && p.id) {
            const sameIdPlayer = room.players.find((pl) => pl.id === p.id);
            if (sameIdPlayer) {
              let oldSocketAlive = false;
              for (const client of wss.clients) {
                if ((client as any).socketId === (sameIdPlayer as any).socketId && client.readyState === WebSocket.OPEN) {
                  oldSocketAlive = true;
                  break;
                }
              }
              if (oldSocketAlive) {
                p.originalId = sameIdPlayer.originalId || sameIdPlayer.id || p.id;
                p.originalName = sameIdPlayer.originalName || sameIdPlayer.name || p.name;
                p.id = `${p.id}_tab_${currentSocketId}`;
                p.name = `${p.name} #${room.players.length + 1}`;
              } else {
                existingIdx = room.players.indexOf(sameIdPlayer);
              }
            }
          }

          if (existingIdx === -1 && (room.players.length >= room.maxPlayers || room.status === 'playing' || room.status === 'starting')) {
            const newRoomId = `SCENE-${gType}-${sMode}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
            room = {
              id: newRoomId,
              gameType: gType,
              sceneMode: sMode,
              sceneName: sName,
              maxPlayers: maxP,
              players: [],
              status: 'waiting',
              createdAt: Date.now(),
            };
            sceneWaitingRooms.set(newRoomId, room);
            existingIdx = -1;
          }

          if (existingIdx !== -1) {
            room.players[existingIdx] = { ...room.players[existingIdx], ...p, socketId: currentSocketId, isReady: true } as any;
          } else if (room.players.length < room.maxPlayers) {
            const usedSeats = new Set(room.players.map((pl) => pl.seat));
            let freeSeat = 0;
            while (usedSeats.has(freeSeat) && freeSeat < room.maxPlayers) freeSeat++;
            p.seat = freeSeat;
            (p as any).socketId = currentSocketId;
            (p as any).isReady = true;
            room.players.push(p);
          }

          (ws as any).sceneRoomId = room.id;
          (ws as any).scenePlayerId = p.id;

          presenceTracker.updateClientGame((ws as any).socketId, gType, sMode);
          presenceTracker.recordClient((ws as any).socketId, {
            gameType: gType,
            playerId: p.id,
            playerName: p.name,
            sceneMode: sMode,
          });

          const isFullStarted = startRoomGameIfFull(room);

          try {
            ws.send(
              JSON.stringify({
                type: 'scene_join_ack',
                roomId: room.id,
                gameType: room.gameType,
                sceneMode: room.sceneMode,
                player: p,
                assignedPlayerId: p.id,
                assignedSeat: p.seat,
                players: room.players,
                maxPlayers: room.maxPlayers,
                status: room.status,
                deal: (room as any).deal ? sanitizeDealForSeat(room.gameType, (room as any).deal, p.seat) : undefined,
              })
            );
          } catch {}

          broadcast({
            type: 'presence_counts',
            counts: presenceTracker.getRealGamePresence(),
          });
          broadcastTeahousePlayers();

          if (!isFullStarted) {
            room.status = 'waiting';
            delete (room as any).deal;
            broadcast({
              type: 'scene_room_update',
              roomId: room.id,
              gameType: room.gameType,
              sceneMode: room.sceneMode,
              players: room.players,
              maxPlayers: room.maxPlayers,
              status: room.status,
            });
          }

          broadcast({
            type: 'presence_counts',
            counts: presenceTracker.getRealGamePresence(),
          });
          return;
        }

        if (msg.type === 'scene_leave') {
          presenceTracker.updateClientGame((ws as any).socketId, 'lobby');
          const currentSocketId = (ws as any).socketId;
          const leavePlayerId = msg.playerId || (ws as any).scenePlayerId;
          const leavePlayerName = msg.playerName;
          const targetRoomId = msg.roomId || (ws as any).sceneRoomId;

          const findLeavingPlayer = (playersList: any[]) => {
            if (!Array.isArray(playersList)) return undefined;
            return (
              playersList.find((pl) => (pl as any).socketId && (pl as any).socketId === currentSocketId) ||
              (leavePlayerId
                ? playersList.find((pl) => pl.id === leavePlayerId || (pl as any).originalId === leavePlayerId)
                : undefined) ||
              (leavePlayerName ? playersList.find((pl) => pl.name === leavePlayerName) : undefined)
            );
          };

          for (const [id, room] of sceneWaitingRooms.entries()) {
            const leavingPl = findLeavingPlayer(room.players);
            const isTargetRoom = targetRoomId ? id === targetRoomId : Boolean(leavingPl);

            if (isTargetRoom && leavingPl) {
              const authRoom = rooms.get(id);
              const isShisanshuiReservation = room.gameType === 'shisanshui' && room.sceneMode === 'reservation';
              const isMatchActive =
                (room.status === 'starting' || room.status === 'playing') &&
                !isShisanshuiReservation &&
                authRoom?.boardState?.phase !== 'ended';

              if (isMatchActive) {
                const plSeat = leavingPl.seat;
                (leavingPl as any).isDisconnected = true;
                (leavingPl as any).isAutoManaged = true;
                delete (leavingPl as any).socketId;

                if (authRoom) {
                  const aPl = (authRoom.players || []).find(
                    (p: any) => p.id === leavingPl.id || (p.socketId && p.socketId === currentSocketId)
                  );
                  if (aPl) {
                    (aPl as any).isDisconnected = true;
                    (aPl as any).isAutoManaged = true;
                    delete (aPl as any).socketId;
                  }
                  if (!authRoom.boardState) {
                    authRoom.boardState = createDefaultBoardState(authRoom.id, authRoom.gameType);
                  }
                  if (!authRoom.boardState.autoManagedSeats) authRoom.boardState.autoManagedSeats = {};
                  authRoom.boardState.autoManagedSeats[plSeat] = true;
                  if (authRoom.turnSeat === plSeat) {
                    authRoom.lastTurnTs = Date.now() - 2000;
                  }
                }

                broadcast({
                  type: 'scene_room_update',
                  roomId: room.id,
                  gameType: room.gameType,
                  sceneMode: room.sceneMode,
                  players: room.players,
                  maxPlayers: room.maxPlayers,
                  status: room.status,
                });
                broadcast({
                  type: 'game_event',
                  roomId: room.id,
                  seat: plSeat,
                  event: {
                    action: 'set_auto_host',
                    seat: plSeat,
                    absSeat: plSeat,
                    isAutoManaged: true,
                    isAutoHost: true,
                    isDisconnected: true,
                    playerName: leavingPl.name,
                  },
                  payload: {
                    action: 'set_auto_host',
                    seat: plSeat,
                    absSeat: plSeat,
                    isAutoManaged: true,
                    isAutoHost: true,
                    isDisconnected: true,
                    playerName: leavingPl.name,
                  },
                  boardState: sanitizeBoardStateForSeat(
                    authRoom ? authRoom.boardState : (room as any).boardState,
                    room.gameType,
                    -1
                  ),
                });
              } else {
                const wasFinishedSettlement = room.status === 'finished' || authRoom?.boardState?.phase === 'ended';
                room.players = room.players.filter((pl) => pl !== leavingPl);

                if (room.players.length === 0) {
                  sceneWaitingRooms.delete(id);
                  rooms.delete(id);
                } else if (wasFinishedSettlement) {
                  // 结算期间有人主动退出大厅：保留剩余玩家原席位编号、结算界面与准备人数统计
                  if (authRoom) {
                    authRoom.players = (authRoom.players || []).filter(
                      (ap: any) => ap.id !== leavingPl.id && (!ap.socketId || ap.socketId !== currentSocketId)
                    );
                  }
                  broadcast({
                    type: 'scene_room_update',
                    roomId: room.id,
                    gameType: room.gameType,
                    sceneMode: room.sceneMode,
                    players: room.players,
                    maxPlayers: room.maxPlayers,
                    status: room.status,
                    settlementExpiresAt: (room as any).settlementExpiresAt || authRoom?.settlementExpiresAt || null,
                    serverTs: Date.now(),
                  });
                } else {
                  room.players.forEach((pl, idx) => {
                    pl.seat = idx;
                  });
                  if (room.players.length < room.maxPlayers) {
                    room.status = 'waiting';
                    delete (room as any).deal;
                  }
                  if (authRoom) {
                    authRoom.players = room.players.map((pl, idx) => ({ ...pl, seat: idx }));
                    authRoom.status = room.status;
                    if (room.status === 'waiting') {
                      delete (authRoom as any).deal;
                    }
                  }
                  broadcast({
                    type: 'scene_room_update',
                    roomId: room.id,
                    gameType: room.gameType,
                    sceneMode: room.sceneMode,
                    players: room.players,
                    maxPlayers: room.maxPlayers,
                    status: room.status,
                  });
                }
              }
            }
          }
          if (msg.roomId && rooms.has(msg.roomId) && !sceneWaitingRooms.has(msg.roomId)) {
            const r = rooms.get(msg.roomId);
            if (r && r.status !== 'playing' && r.status !== 'starting') {
              const rLeave = findLeavingPlayer(r.players);
              if (rLeave) {
                r.players = r.players.filter((pl: any) => pl !== rLeave);
                if (r.players.length === 0) {
                  rooms.delete(msg.roomId);
                } else {
                  r.status = 'waiting';
                  delete (r as any).deal;
                }
              }
            }
          }
          for (let i = activeChallenges.length - 1; i >= 0; i--) {
            const ch = activeChallenges[i];
            if (
              (ch.senderId === msg.playerId || ch.senderName === msg.playerName) &&
              (!msg.sceneMode || ch.sceneMode === msg.sceneMode) &&
              !ch.acceptedBy
            ) {
              const removedId = ch.id;
              activeChallenges.splice(i, 1);
              broadcast({
                type: 'challenge_status_update',
                challengeId: removedId,
                status: 'removed',
                senderId: msg.playerId,
                senderName: msg.playerName,
                gameType: ch.gameType,
                sceneMode: ch.sceneMode,
              });
            }
          }
          broadcast({
            type: 'presence_counts',
            counts: presenceTracker.getRealGamePresence(),
          });
          return;
        }

        if (msg.type === 'scene_chat') {
          const isChallenge = msg.action === 'challenge';
          const targetChannel = isChallenge ? 'hall' : msg.channel || 'hall';

          if (isChallenge && msg.gameType && msg.sceneMode) {
            const senderId = msg.senderId || 'P-guest';
            const senderName = msg.sender || '牌友';

            const previousUserChallenges = activeChallenges.filter(
              (c) =>
                (c.senderId === senderId || c.senderName === senderName) &&
                c.status !== 'cancelled' &&
                c.status !== 'removed'
            );

            for (const oldCh of previousUserChallenges) {
              if (oldCh.acceptedBy) {
                const newHost = oldCh.acceptedBy;
                oldCh.senderId = newHost.id;
                oldCh.senderName = newHost.name;
                oldCh.status = 'transferred';
                oldCh.text = `⚔️ 在【${oldCh.sceneName}】由 [${newHost.name}] 继承守擂：“谁来与我一战到底！”`;
                const oldAcceptedHost = { ...newHost };
                oldCh.acceptedBy = undefined;

                broadcast({
                  type: 'challenge_status_update',
                  challengeId: oldCh.id,
                  status: 'transferred',
                  newSenderId: oldAcceptedHost.id,
                  newSenderName: oldAcceptedHost.name,
                  gameType: oldCh.gameType,
                  sceneMode: oldCh.sceneMode,
                  sceneName: oldCh.sceneName,
                  text: oldCh.text,
                });

                broadcast({
                  type: 'scene_chat_broadcast',
                  gameType: oldCh.gameType,
                  sceneMode: oldCh.sceneMode,
                  sceneName: oldCh.sceneName,
                  channel: 'hall',
                  sender: '🤖 牌楼官播 BOT',
                  senderId: 'BOT-SYSTEM',
                  avatar: '🤖',
                  text: `⚔️【擂台过继】牌友 [${senderName}] 已移步至新场景，原【${oldCh.sceneName}】战帖已顺位过继由 [${oldAcceptedHost.name}] 继承守擂！`,
                  action: 'notice',
                  timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
                });
              } else {
                const rmIdx = activeChallenges.findIndex((c) => c.id === oldCh.id);
                if (rmIdx !== -1) {
                  activeChallenges.splice(rmIdx, 1);
                }

                broadcast({
                  type: 'challenge_status_update',
                  challengeId: oldCh.id,
                  status: 'removed',
                  senderId,
                  senderName,
                  gameType: oldCh.gameType,
                  sceneMode: oldCh.sceneMode,
                });
              }
            }

            const newCh: ActiveChallengeRecord = {
              id: msg.challengeId || `ch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              senderId,
              senderName,
              avatar: msg.avatar || '👑',
              gameType: msg.gameType,
              sceneMode: msg.sceneMode,
              sceneName: msg.sceneName || '经典分场',
              text: msg.text ? String(msg.text).slice(0, 200) : '摆下战帖，谁敢来与我一战到底！',
              status: 'open',
              timestamp: msg.timestamp || new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
              createdAt: Date.now(),
            };
            activeChallenges.unshift(newCh);
            if (activeChallenges.length > 30) activeChallenges.pop();

            msg.challengeId = newCh.id;
          }

          broadcast({
            type: 'scene_chat_broadcast',
            challengeId: msg.challengeId || null,
            gameType: msg.gameType,
            sceneMode: msg.sceneMode,
            sceneName: msg.sceneName || null,
            channel: targetChannel,
            sender: msg.sender || '牌友',
            senderId: msg.senderId || null,
            avatar: msg.avatar || '👑',
            text: msg.text ? String(msg.text || '').slice(0, 200) : '🎤 [等候室实时语音]',
            voice: Boolean(msg.voice),
            phraseText: msg.phraseText ? String(msg.phraseText).slice(0, 200) : null,
            roleId: msg.roleId || null,
            roleName: msg.roleName || null,
            pitch: typeof msg.pitch === 'number' ? msg.pitch : 1.0,
            rate: typeof msg.rate === 'number' ? msg.rate : 1.0,
            isFemale: Boolean(msg.isFemale),
            audio: msg.audio || null,
            duration: Number(msg.duration) || 0,
            action: msg.action || null,
            targetPlayerId: msg.targetPlayerId || null,
            targetPlayerName: msg.targetPlayerName || null,
            giftAmount: Number(msg.giftAmount) || 0,
            timestamp: msg.timestamp || new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
            activeChallenges: activeChallenges.slice(0, 10),
          });
          return;
        }

        if (msg.type === 'scene_accept_challenge') {
          const found = activeChallenges.find(
            (c) => c.id === msg.challengeId || (c.senderName === msg.challengerName && c.sceneMode === msg.sceneMode && c.status === 'open')
          );
          if (found) {
            found.status = 'accepted';
            found.acceptedBy = { id: msg.acceptorId || 'guest', name: msg.acceptorName || '热血牌友' };

            broadcast({
              type: 'challenge_status_update',
              challengeId: found.id,
              status: 'accepted',
              acceptedBy: found.acceptedBy,
            });
          }

          if (msg.gameType && msg.sceneMode) {
            presenceTracker.updateClientGame((ws as any).socketId, msg.gameType, msg.sceneMode);
            if (msg.acceptorId) {
              presenceTracker.recordClient((ws as any).socketId, {
                gameType: msg.gameType,
                playerId: msg.acceptorId,
                playerName: msg.acceptorName,
                sceneMode: msg.sceneMode,
              });
            }
            broadcast({
              type: 'presence_counts',
              counts: presenceTracker.getRealGamePresence(),
            });
            broadcastTeahousePlayers();
          }

          broadcast({
            type: 'scene_chat_broadcast',
            gameType: msg.gameType,
            sceneMode: msg.sceneMode,
            sceneName: msg.sceneName,
            channel: 'hall',
            sender: '🤖 牌楼官播 BOT',
            senderId: 'BOT-SYSTEM',
            avatar: '🤖',
            text: `⚔️【应战捷报】牌友 [${msg.acceptorName || '热血牌友'}] 已成功响应 [${msg.challengerName || '牌友'}] 在【${msg.sceneName || '经典分场'}】的擂台战帖，已切入相同桌台！`,
            action: 'notice',
            timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
            activeChallenges: activeChallenges.slice(0, 10),
          });
          return;
        }

        if (msg.type === 'room_create') {
          const id = `RM-${Math.floor(207 + Math.random() * 800)}`;
          const gType = msg.gameType || 'yansan';
          const cleanPasscode = typeof msg.passcode === 'string' ? msg.passcode.trim().slice(0, 6) : '';
          const pId = msg.playerId || (ws as any).authenticatedUserId || `P-${Date.now()}`;
          const newRoom: any = {
            id,
            title: msg.title || `${msg.playerName || '茗局雅客'}的牌局`,
            gameType: gType,
            status: 'playing',
            hasPasscode: Boolean(cleanPasscode),
            _passcode: cleanPasscode,
            players: [{ id: pId, name: msg.playerName || '茗局雅客', rating: 1900, seat: 0, socketId: (ws as any).socketId }],
            spectators: 1,
            turnSeat: 0,
            moveCount: 0,
            modeLabel: cleanPasscode ? '私密口令牌桌' : '实时 WebSocket 牌桌',
            chat: [
              {
                id: `c-${Date.now()}`,
                sender: '系统司仪',
                text: `房间 ${id} 已建立${cleanPasscode ? '（已设私密口令）' : ''}，欢迎各路牌友入席！`,
                timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
              },
            ],
            boardState: createDefaultBoardState(id, gType),
          };
          rooms.set(id, newRoom);
          const safeRooms = Array.from(rooms.values()).map(({ _passcode: _p, ...rest }: any) => rest);
          const { _passcode: _pSelf, ...safeNewRoom } = newRoom;
          broadcast({ type: 'room_created', room: safeNewRoom, rooms: safeRooms });
          return;
        }

        if (msg.type === 'room_join') {
          const room: any = rooms.get(msg.roomId);
          if (room) {
            if (room._passcode && String(msg.passcode || '').trim() !== room._passcode) {
              ws.send(
                JSON.stringify({
                  type: 'room_join_rejected',
                  roomId: room.id,
                  reason: 'invalid_passcode',
                  error: '私密房间口令不正确，请核对后再试',
                })
              );
              return;
            }
            const playerName = msg.playerName || '牌友';
            const pId = msg.playerId || (ws as any).authenticatedUserId || `P-${Date.now()}`;
            const existingPlayer = room.players.find((p: any) => p.id === pId || p.name === playerName);
            if (!existingPlayer && room.players.length < 4) {
              room.players.push({
                id: pId,
                name: playerName,
                rating: msg.rating || 1900,
                seat: room.players.length,
                socketId: (ws as any).socketId,
              });
            } else {
              if (existingPlayer) existingPlayer.socketId = (ws as any).socketId;
              room.spectators += 1;
            }
            const safeRooms = Array.from(rooms.values()).map(({ _passcode: _p, ...rest }: any) => rest);
            const { _passcode: _pSelf, ...safeRoom } = room;
            broadcast({ type: 'room_updated', room: safeRoom, rooms: safeRooms });
          }
          return;
        }

        if (msg.type === 'room_leave') {
          const room: any = rooms.get(msg.roomId);
          if (room) {
            room.spectators = Math.max(0, room.spectators - 1);
            const safeRooms = Array.from(rooms.values()).map(({ _passcode: _p, ...rest }: any) => rest);
            const { _passcode: _pSelf, ...safeRoom } = room;
            broadcast({ type: 'room_updated', room: safeRoom, rooms: safeRooms });
          }
          return;
        }

        if (msg.type === 'room_reconnect') {
          const room: any = rooms.get(msg.roomId);
          if (room) {
            try {
              const pId = (ws as any).scenePlayerId;
              const matched = room.players?.find((p: any) => p.id === pId || p.socketId === (ws as any).socketId);
              const seat = matched && typeof matched.seat === 'number' ? matched.seat : -1;
              const { deal: _d, _passcode: _pSelf, ...roomWithoutDeal } = room;
              ws.send(
                JSON.stringify({
                  type: 'reconnect_ack',
                  room: {
                    ...roomWithoutDeal,
                    deal: room.deal ? sanitizeDealForSeat(room.gameType, room.deal, seat) : undefined,
                  },
                  boardState: sanitizeBoardStateForSeat(room.boardState, room.gameType, seat),
                  serverTs: Date.now(),
                })
              );
            } catch {}
          }
          return;
        }

        if (msg.type === 'request_game_deal') {
          const targetRoomId = msg.roomId;
          const r = (sceneWaitingRooms.get(targetRoomId) as any) || rooms.get(targetRoomId);
          if (r) {
            if (!r.deal) {
              r.deal = generateRoomDeal(r.gameType, r.sceneMode, r.maxPlayers);
            }
            const pId = msg.playerId || (ws as any).scenePlayerId;
            const matched = r.players?.find(
              (pl: any) => pl.socketId === (ws as any).socketId || (pId && pl.id === pId)
            );
            const seat = matched && typeof matched.seat === 'number' ? matched.seat : (typeof msg.seat === 'number' ? msg.seat : -1);
            ws.send(
              JSON.stringify({
                type: 'game_deal',
                roomId: targetRoomId,
                gameType: r.gameType,
                sceneMode: r.sceneMode,
                deal: sanitizeDealForSeat(r.gameType, r.deal, seat),
              })
            );
          }
          return;
        }

        if (msg.type === 'game_move') {
          const targetRoomId = msg.roomId;
          const room = rooms.get(targetRoomId) || (sceneWaitingRooms.get(targetRoomId) as any);
          if (room) {
            const evt = msg.event || {};
            const p = { ...evt, ...(msg.payload || {}) };
            const action = p.action || evt.action || 'play';
            const combo = p.combo || evt.combo || null;

            const requestedSeat =
              typeof msg.seat === 'number'
                ? msg.seat
                : typeof evt.seat === 'number'
                  ? evt.seat
                  : typeof p.seat === 'number'
                    ? p.seat
                    : 0;
            const wsSocketId = (ws as any).socketId;
            const wsPlayerId = (ws as any).authenticatedUserId || (ws as any).scenePlayerId;
            const senderPlayer = Array.isArray(room.players)
              ? room.players.find(
                  (pl: any) =>
                    (pl.socketId && wsSocketId && pl.socketId === wsSocketId) ||
                    (pl.id && wsPlayerId && pl.id === wsPlayerId)
                )
              : undefined;

            const mutatingActions = new Set([
              'play',
              'pass',
              'draw',
              'discard',
              'peng',
              'gang',
              'hu',
              'draw_stalemate',
              'finish',
              'qianggong',
              'surrender',
              'shisanshui_submit_hand',
            ]);

            if (!senderPlayer && mutatingActions.has(action)) {
              return;
            }

            let seat = senderPlayer && typeof senderPlayer.seat === 'number' ? senderPlayer.seat : requestedSeat;
            // Allow host/player to drive non-human AI bots in hybrid rooms, while forbidding spoofing other human players
            if (
              senderPlayer &&
              requestedSeat !== senderPlayer.seat &&
              Array.isArray(room.players) &&
              room.players[requestedSeat] &&
              isBotLikePlayer(room.players[requestedSeat])
            ) {
              seat = requestedSeat;
            }

            if (!room.boardState) {
              room.boardState = createDefaultBoardState(room.id, room.gameType);
            }
            const bs = room.boardState;

            if (bs.phase === 'ended' && mutatingActions.has(action)) {
              return;
            }

            if (action === 'set_auto_host') {
              const isAuto = Boolean(p.isAutoManaged ?? p.isAutoHost);
              if (room.players && room.players[seat]) {
                room.players[seat].isAutoManaged = isAuto;
              }
              const sRoom = sceneWaitingRooms.get(room.id);
              if (sRoom && sRoom.players && sRoom.players[seat]) {
                sRoom.players[seat].isAutoManaged = isAuto;
              }
              if (!bs.autoManagedSeats) bs.autoManagedSeats = {};
              bs.autoManagedSeats[seat] = isAuto;
              if (isAuto && room.turnSeat === seat) {
                room.lastTurnTs = Date.now() - 2000;
              }
              broadcast({
                type: 'game_event',
                roomId: room.id,
                seat,
                event: { action: 'set_auto_host', seat, absSeat: seat, isAutoManaged: isAuto, isAutoHost: isAuto },
                payload: { action: 'set_auto_host', seat, absSeat: seat, isAutoManaged: isAuto, isAutoHost: isAuto },
                boardState: bs,
              });
              return;
            }

            // ==========================================
            // 1. 麻将权威裁决中枢
            // ==========================================
            if (room.gameType === 'mahjong') {
              if (!bs.extraState) bs.extraState = {};
              if (!bs.extraState.mahjongDiscards) bs.extraState.mahjongDiscards = [];
              if (!bs.extraState.mahjongMelds) bs.extraState.mahjongMelds = [[], [], [], []];
              if (bs.extraState.wallRemaining === undefined) {
                bs.extraState.wallRemaining = (room as any).deal?.remainingWall?.length ?? 83;
              }

              const isHongzhongMode = room.sceneMode?.includes('hongzhong') ?? true;
              const isTileMatch = (a: any, b: any) => Boolean(a && b && a.type === b.type && Number(a.value) === Number(b.value));
              const isRedDragonTile = (t: any) =>
                Boolean(t && t.type === 'zi' && (Number(t.value) === 5 || t.text === '红中' || t.isRedDragon));

              const sendMahjongReject = (rejectAction: string, reason: string, extra: Record<string, any> = {}) => {
                const seatHand = Array.isArray((room as any).deal?.seatCards?.[seat]) ? [...(room as any).deal.seatCards[seat]] : undefined;
                const rejectEvt = {
                  action: rejectAction,
                  seat,
                  absSeat: seat,
                  turnSeat: bs.turnSeat,
                  pendingPengSeat: bs.extraState?.pendingPengSeat ?? null,
                  wallRemaining: bs.extraState?.wallRemaining ?? ((room as any).deal?.remainingWall?.length ?? 0),
                  seatHand,
                  reason,
                  ...extra,
                };
                try {
                  ws.send(
                    JSON.stringify({
                      type: 'game_event',
                      roomId: room.id,
                      seat,
                      event: rejectEvt,
                      payload: rejectEvt,
                      boardState: bs,
                    })
                  );
                } catch {}
              };

              const tile = p.tile || evt.tile;

              if (action === 'discard') {
                const sCards: any[] | undefined = (room as any).deal?.seatCards?.[seat];
                if (
                  (bs.extraState.pendingPengSeat !== null &&
                    bs.extraState.pendingPengSeat !== undefined &&
                    bs.extraState.pendingPengSeat !== seat) ||
                  (typeof bs.turnSeat === 'number' && bs.turnSeat !== seat)
                ) {
                  sendMahjongReject('discard_rejected', 'not_your_turn', { tile });
                  return;
                }
                if (Array.isArray(sCards) && sCards.length % 3 !== 2) {
                  sendMahjongReject('discard_rejected', 'invalid_hand_count', { tile });
                  return;
                }
                let matchedTile = tile;
                if (Array.isArray(sCards)) {
                  if (!tile) {
                    sendMahjongReject('discard_rejected', 'missing_tile');
                    return;
                  }
                  let fIdx = tile.id ? sCards.findIndex((c: any) => c.id === tile.id) : -1;
                  if (fIdx < 0) {
                    fIdx = sCards.findIndex((c: any) => isTileMatch(c, tile));
                  }
                  if (fIdx < 0) {
                    sendMahjongReject('discard_rejected', 'tile_not_in_hand', { tile });
                    return;
                  }
                  matchedTile = sCards.splice(fIdx, 1)[0];
                }

                const discTile = matchedTile ? { ...matchedTile, discardBy: seat } : tile;
                if (discTile) {
                  bs.extraState.mahjongDiscards.push(discTile);
                  bs.extraState.lastDiscarded = discTile;
                  p.tile = discTile;
                  if (!bs.discardsHistory) bs.discardsHistory = [];
                  bs.discardsHistory.push({ type: 'mahjong_discard', rank: discTile.value || 0, cards: [discTile], seat });
                }

                if (Array.isArray(sCards)) {
                  bs.handsCount[seat] = sCards.length;
                } else if (bs.handsCount && bs.handsCount[seat] > 0) {
                  bs.handsCount[seat] = Math.max(0, bs.handsCount[seat] - 1);
                }

                const nextTurnSeat = p.nextTurn !== undefined ? Number(p.nextTurn) : (seat + 1) % 4;
                bs.turnSeat = nextTurnSeat;
                room.turnSeat = nextTurnSeat;
                bs.extraState.pendingPengSeat = null;
                bs.extraState.lastDrawnSeat = null;
                bs.extraState.lastDrawnTile = null;

                const wallArr = (room as any).deal?.remainingWall;
                if (Array.isArray(wallArr)) {
                  bs.extraState.wallRemaining = wallArr.length;
                }
                p.wallRemaining = bs.extraState.wallRemaining;

                const pendingClaimSeats = discTile ? computeMahjongClaimPendingSeats(room, bs, seat, discTile) : [];
                if (pendingClaimSeats.length > 0) {
                  bs.extraState.claimWindow = {
                    discardId: discTile.id,
                    discarderSeat: seat,
                    pendingSeats: pendingClaimSeats,
                    passedSeats: [],
                    createdAt: Date.now(),
                  };
                } else {
                  bs.extraState.claimWindow = null;
                }
                p.pendingClaimSeats = pendingClaimSeats;
                p.hasClaimWindow = pendingClaimSeats.length > 0;

                room.moveCount = (room.moveCount || 0) + 1;
                bs.actionSeq = (bs.actionSeq || 0) + 1;
                bs.moveCount = room.moveCount;
                bs.updatedAt = Date.now();
                room.lastTurnTs = Date.now();

                const discEvtPayload = { ...p, action: 'discard', seat, nextTurn: nextTurnSeat };
                broadcast({
                  type: 'game_event',
                  roomId: room.id,
                  seat,
                  event: discEvtPayload,
                  payload: discEvtPayload,
                  moveCount: room.moveCount,
                  boardState: bs,
                });

                // 无人可碰/杠该废牌时：若牌墙已空立即荒庄流局，否则下发 claim_resolved 放行下家摸牌
                if (pendingClaimSeats.length === 0) {
                  if (Array.isArray(wallArr) && wallArr.length === 0) {
                    executeMahjongDrawStalemate(room, nextTurnSeat, '牌墙抓毕，本局荒庄（流局）！');
                  } else {
                    bs.actionSeq = (bs.actionSeq || 0) + 1;
                    const crPayload = {
                      action: 'claim_resolved',
                      discardId: discTile?.id || null,
                      nextTurn: nextTurnSeat,
                      wallRemaining: bs.extraState.wallRemaining,
                    };
                    broadcast({
                      type: 'game_event',
                      roomId: room.id,
                      seat: nextTurnSeat,
                      event: crPayload,
                      payload: crPayload,
                      moveCount: room.moveCount,
                      boardState: bs,
                    });
                  }
                }
                return;
              } else if (action === 'draw') {
                const cw = bs.extraState.claimWindow;
                if (cw && cw.pendingSeats.some((ps: number) => !cw.passedSeats.includes(ps))) {
                  sendMahjongReject('draw_rejected', 'claim_window_open');
                  return;
                }
                if (
                  bs.extraState.pendingPengSeat !== null &&
                  bs.extraState.pendingPengSeat !== undefined &&
                  bs.extraState.pendingPengSeat !== seat
                ) {
                  sendMahjongReject('draw_rejected', 'pending_peng');
                  return;
                }
                if (bs.turnSeat !== seat) {
                  sendMahjongReject('draw_rejected', 'not_your_turn');
                  return;
                }
                const sCards: any[] | undefined = (room as any).deal?.seatCards?.[seat];
                if (Array.isArray(sCards) && sCards.length % 3 !== 1) {
                  sendMahjongReject('draw_rejected', 'already_drew');
                  return;
                }
                const wallArr = (room as any).deal?.remainingWall;
                if (!Array.isArray(wallArr) || wallArr.length === 0) {
                  executeMahjongDrawStalemate(room, seat, '牌墙抓毕，本局荒庄（流局）！');
                  return;
                }
                const drawn = wallArr.shift();
                if (drawn && (room as any).deal?.seatCards?.[seat]) {
                  (room as any).deal.seatCards[seat].push(drawn);
                }
                bs.extraState.wallRemaining = wallArr.length;
                p.tile = drawn;
                p.wallRemaining = wallArr.length;
                bs.turnSeat = seat;
                room.turnSeat = bs.turnSeat;
                room.moveCount = (room.moveCount || 0) + 1;
                bs.actionSeq = (bs.actionSeq || 0) + 1;
                bs.moveCount = room.moveCount;
                bs.updatedAt = Date.now();
                room.lastTurnTs = Date.now();
                if (bs.handsCount) {
                  bs.handsCount[seat] = (room as any).deal?.seatCards?.[seat]?.length ?? ((bs.handsCount[seat] || 13) + 1);
                }
                bs.extraState.lastDrawnSeat = seat;
                bs.extraState.lastDrawnTile = drawn;
              } else if (action === 'peng') {
                const lastDisc = bs.extraState.lastDiscarded;
                const sCards: any[] | undefined = (room as any).deal?.seatCards?.[seat];
                if (
                  !lastDisc ||
                  (bs.extraState.pendingPengSeat !== null && bs.extraState.pendingPengSeat !== undefined) ||
                  lastDisc.discardBy === seat ||
                  !tile ||
                  !isTileMatch(tile, lastDisc) ||
                  (p.targetDiscardId && lastDisc.id !== p.targetDiscardId) ||
                  (isHongzhongMode && isRedDragonTile(lastDisc))
                ) {
                  sendMahjongReject('claim_rejected', 'discard_not_available', { claimType: 'peng', tile });
                  return;
                }
                if (Array.isArray(sCards)) {
                  const matchCount = sCards.filter((c: any) => isTileMatch(c, lastDisc)).length;
                  if (sCards.length % 3 !== 1 || matchCount < 2) {
                    sendMahjongReject('claim_rejected', 'insufficient_matching_tiles', { claimType: 'peng', tile });
                    return;
                  }
                }

                bs.extraState.claimWindow = null;

                let canceledDrawSeat: number | null = null;
                let canceledDrawTile: any = null;
                if (bs.extraState.lastDrawnSeat !== null && bs.extraState.lastDrawnSeat !== undefined && bs.extraState.lastDrawnSeat !== seat) {
                  canceledDrawSeat = bs.extraState.lastDrawnSeat;
                  const dSeat = canceledDrawSeat;
                  const drawnRef = bs.extraState.lastDrawnTile;
                  const seatHand = (room as any).deal?.seatCards?.[dSeat];
                  if (Array.isArray(seatHand) && seatHand.length % 3 === 2) {
                    let returned: any = null;
                    if (drawnRef?.id) {
                      const idx = seatHand.findIndex((c: any) => c.id === drawnRef.id);
                      if (idx >= 0) returned = seatHand.splice(idx, 1)[0];
                    }
                    if (!returned) returned = seatHand.pop();
                    if (returned && Array.isArray((room as any).deal.remainingWall)) {
                      (room as any).deal.remainingWall.unshift(returned);
                      canceledDrawTile = returned;
                    }
                  }
                  if (Array.isArray((room as any).deal?.remainingWall)) {
                    bs.extraState.wallRemaining = (room as any).deal.remainingWall.length;
                  } else if (typeof bs.extraState.wallRemaining === 'number') {
                    bs.extraState.wallRemaining++;
                  }
                  if (bs.handsCount && bs.handsCount[dSeat] > 0) {
                    bs.handsCount[dSeat] = (room as any).deal?.seatCards?.[dSeat]?.length ?? Math.max(0, bs.handsCount[dSeat] - 1);
                  }
                  bs.extraState.lastDrawnSeat = null;
                  bs.extraState.lastDrawnTile = null;
                }

                let claimedTile = lastDisc;
                if (bs.extraState.mahjongDiscards.length > 0) {
                  const lastIdx = bs.extraState.mahjongDiscards.length - 1;
                  if (bs.extraState.mahjongDiscards[lastIdx].id === lastDisc.id) {
                    claimedTile = bs.extraState.mahjongDiscards.pop();
                  } else {
                    const fIdx = bs.extraState.mahjongDiscards.findIndex((d: any) => d.id === lastDisc.id);
                    if (fIdx >= 0) claimedTile = bs.extraState.mahjongDiscards.splice(fIdx, 1)[0];
                  }
                }
                const removedHandTiles: any[] = [];
                if (Array.isArray(sCards)) {
                  for (let i = sCards.length - 1; i >= 0 && removedHandTiles.length < 2; i--) {
                    if (isTileMatch(sCards[i], lastDisc)) {
                      removedHandTiles.push(sCards.splice(i, 1)[0]);
                    }
                  }
                }
                const pengMeldTiles = [...removedHandTiles, claimedTile];
                if (!bs.extraState.mahjongMelds[seat]) bs.extraState.mahjongMelds[seat] = [];
                bs.extraState.mahjongMelds[seat].push({
                  type: 'peng',
                  tile: claimedTile,
                  tiles: pengMeldTiles,
                  seat,
                });
                bs.extraState.lastDiscarded = null;
                bs.extraState.pendingPengSeat = seat;
                bs.turnSeat = seat;
                room.turnSeat = bs.turnSeat;
                room.moveCount = (room.moveCount || 0) + 1;
                bs.actionSeq = (bs.actionSeq || 0) + 1;
                bs.moveCount = room.moveCount;
                bs.updatedAt = Date.now();
                room.lastTurnTs = Date.now();
                if (Array.isArray(sCards)) {
                  bs.handsCount[seat] = sCards.length;
                } else if (bs.handsCount && bs.handsCount[seat] >= 2) {
                  bs.handsCount[seat] -= 2;
                }
                p.tile = claimedTile;
                p.meldTiles = pengMeldTiles;
                p.wallRemaining = bs.extraState.wallRemaining;
                if (canceledDrawSeat !== null) {
                  p.canceledDrawSeat = canceledDrawSeat;
                  if (canceledDrawTile) p.canceledDrawTile = canceledDrawTile;
                }
              } else if (action === 'gang') {
                const seatMelds = bs.extraState.mahjongMelds[seat] || [];
                const sCards: any[] | undefined = (room as any).deal?.seatCards?.[seat];
                const lastDisc = bs.extraState.lastDiscarded;
                let resolvedGangType: 'ming' | 'an' | 'bu' = 'ming';
                if (p.gangType === 'bu') {
                  resolvedGangType = 'bu';
                } else if (p.gangType === 'an') {
                  resolvedGangType = 'an';
                } else if (p.gangType === 'an_or_bu') {
                  const hasMatchingPeng = Boolean(
                    tile && seatMelds.some((m: any) => m.type === 'peng' && m.tile && isTileMatch(m.tile, tile))
                  );
                  resolvedGangType = hasMatchingPeng ? 'bu' : 'an';
                } else if (!p.isMingGang && p.fromSeat === undefined && !(lastDisc && lastDisc.discardBy !== seat)) {
                  const hasMatchingPeng = Boolean(
                    tile && seatMelds.some((m: any) => m.type === 'peng' && m.tile && isTileMatch(m.tile, tile))
                  );
                  resolvedGangType = hasMatchingPeng ? 'bu' : 'an';
                }
                p.gangType = resolvedGangType;

                const wallForGang = (room as any).deal?.remainingWall;
                if (!Array.isArray(wallForGang) || wallForGang.length === 0) {
                  sendMahjongReject('claim_rejected', 'wall_empty_no_gang', { claimType: 'gang', gangType: resolvedGangType, tile });
                  return;
                }

                if (resolvedGangType === 'ming') {
                  if (
                    !lastDisc ||
                    (bs.extraState.pendingPengSeat !== null && bs.extraState.pendingPengSeat !== undefined) ||
                    lastDisc.discardBy === seat ||
                    !tile ||
                    !isTileMatch(tile, lastDisc) ||
                    (p.targetDiscardId && lastDisc.id !== p.targetDiscardId) ||
                    (isHongzhongMode && isRedDragonTile(lastDisc))
                  ) {
                    sendMahjongReject('claim_rejected', 'discard_not_available', { claimType: 'gang', gangType: 'ming', tile });
                    return;
                  }
                  if (Array.isArray(sCards)) {
                    const matchCount = sCards.filter((c: any) => isTileMatch(c, lastDisc)).length;
                    if (sCards.length % 3 !== 1 || matchCount < 3) {
                      sendMahjongReject('claim_rejected', 'insufficient_matching_tiles', { claimType: 'gang', gangType: 'ming', tile });
                      return;
                    }
                  }
                } else if (resolvedGangType === 'an') {
                  if (
                    bs.turnSeat !== seat ||
                    (bs.extraState.pendingPengSeat !== null &&
                      bs.extraState.pendingPengSeat !== undefined &&
                      bs.extraState.pendingPengSeat !== seat) ||
                    !tile ||
                    (isHongzhongMode && isRedDragonTile(tile))
                  ) {
                    sendMahjongReject('claim_rejected', 'invalid_an_gang', { claimType: 'gang', gangType: 'an', tile });
                    return;
                  }
                  if (Array.isArray(sCards)) {
                    const matchCount = sCards.filter((c: any) => isTileMatch(c, tile)).length;
                    if (sCards.length % 3 !== 2 || matchCount !== 4) {
                      sendMahjongReject('claim_rejected', 'insufficient_matching_tiles', { claimType: 'gang', gangType: 'an', tile });
                      return;
                    }
                  }
                } else if (resolvedGangType === 'bu') {
                  const hasMatchingPeng = Boolean(
                    tile && seatMelds.some((m: any) => m.type === 'peng' && m.tile && isTileMatch(m.tile, tile))
                  );
                  if (
                    bs.turnSeat !== seat ||
                    (bs.extraState.pendingPengSeat !== null &&
                      bs.extraState.pendingPengSeat !== undefined &&
                      bs.extraState.pendingPengSeat !== seat) ||
                    !tile ||
                    !hasMatchingPeng
                  ) {
                    sendMahjongReject('claim_rejected', 'invalid_bu_gang', { claimType: 'gang', gangType: 'bu', tile });
                    return;
                  }
                  if (Array.isArray(sCards)) {
                    const matchCount = sCards.filter((c: any) => isTileMatch(c, tile)).length;
                    if (sCards.length % 3 !== 2 || matchCount < 1) {
                      sendMahjongReject('claim_rejected', 'insufficient_matching_tiles', { claimType: 'gang', gangType: 'bu', tile });
                      return;
                    }
                  }
                }

                bs.extraState.claimWindow = null;

                let canceledDrawSeat: number | null = null;
                let canceledDrawTile: any = null;
                if (resolvedGangType === 'ming') {
                  if (bs.extraState.lastDrawnSeat !== null && bs.extraState.lastDrawnSeat !== undefined && bs.extraState.lastDrawnSeat !== seat) {
                    canceledDrawSeat = bs.extraState.lastDrawnSeat;
                    const dSeat = canceledDrawSeat;
                    const drawnRef = bs.extraState.lastDrawnTile;
                    const seatHand = (room as any).deal?.seatCards?.[dSeat];
                    if (Array.isArray(seatHand) && seatHand.length % 3 === 2) {
                      let returned: any = null;
                      if (drawnRef?.id) {
                        const idx = seatHand.findIndex((c: any) => c.id === drawnRef.id);
                        if (idx >= 0) returned = seatHand.splice(idx, 1)[0];
                      }
                      if (!returned) returned = seatHand.pop();
                      if (returned && Array.isArray((room as any).deal.remainingWall)) {
                        (room as any).deal.remainingWall.unshift(returned);
                        canceledDrawTile = returned;
                      }
                    }
                    if (Array.isArray((room as any).deal?.remainingWall)) {
                      bs.extraState.wallRemaining = (room as any).deal.remainingWall.length;
                    } else if (typeof bs.extraState.wallRemaining === 'number') {
                      bs.extraState.wallRemaining++;
                    }
                    if (bs.handsCount && bs.handsCount[dSeat] > 0) {
                      bs.handsCount[dSeat] = (room as any).deal?.seatCards?.[dSeat]?.length ?? Math.max(0, bs.handsCount[dSeat] - 1);
                    }
                    bs.extraState.lastDrawnSeat = null;
                    bs.extraState.lastDrawnTile = null;
                  }
                }

                const targetMatchTile = resolvedGangType === 'ming' ? lastDisc : tile;
                const removeNeeded = resolvedGangType === 'bu' ? 1 : resolvedGangType === 'an' ? 4 : 3;
                const removedHandTiles: any[] = [];
                if (Array.isArray(sCards)) {
                  for (let i = sCards.length - 1; i >= 0 && removedHandTiles.length < removeNeeded; i--) {
                    if (isTileMatch(sCards[i], targetMatchTile)) {
                      removedHandTiles.push(sCards.splice(i, 1)[0]);
                    }
                  }
                }
                if (Array.isArray(sCards)) {
                  bs.handsCount[seat] = sCards.length;
                } else if (bs.handsCount && typeof bs.handsCount[seat] === 'number') {
                  bs.handsCount[seat] = Math.max(0, bs.handsCount[seat] - removeNeeded);
                }

                if (!bs.extraState.mahjongMelds[seat]) bs.extraState.mahjongMelds[seat] = [];
                if (resolvedGangType === 'bu') {
                  const pengMeldIdx = bs.extraState.mahjongMelds[seat].findIndex(
                    (m: any) => m.type === 'peng' && m.tile && isTileMatch(m.tile, targetMatchTile)
                  );
                  const addedTile = removedHandTiles[0] || targetMatchTile;
                  if (pengMeldIdx >= 0) {
                    const prevMeld = bs.extraState.mahjongMelds[seat][pengMeldIdx];
                    const prevTiles = Array.isArray(prevMeld.tiles) ? prevMeld.tiles : [prevMeld.tile, prevMeld.tile, prevMeld.tile];
                    const fullGangTiles = [...prevTiles, addedTile];
                    bs.extraState.mahjongMelds[seat][pengMeldIdx] = {
                      type: 'gang',
                      tile: addedTile,
                      tiles: fullGangTiles,
                      seat,
                      gangType: 'bu',
                    };
                    p.meldTiles = fullGangTiles;
                  } else {
                    const fallbackTiles = Array.from({ length: 4 }, (_, idx) => ({ ...addedTile, id: `${addedTile.id}-bu-${idx}` }));
                    bs.extraState.mahjongMelds[seat].push({ type: 'gang', tile: addedTile, tiles: fallbackTiles, seat, gangType: 'bu' });
                    p.meldTiles = fallbackTiles;
                  }
                  bs.extraState.lastDiscarded = null;
                } else {
                  let claimedTile = targetMatchTile;
                  if (resolvedGangType === 'ming') {
                    if (bs.extraState.mahjongDiscards.length > 0 && lastDisc) {
                      const lastIdx = bs.extraState.mahjongDiscards.length - 1;
                      if (bs.extraState.mahjongDiscards[lastIdx].id === lastDisc.id) {
                        claimedTile = bs.extraState.mahjongDiscards.pop();
                      } else {
                        const fIdx = bs.extraState.mahjongDiscards.findIndex((d: any) => d.id === lastDisc.id);
                        if (fIdx >= 0) claimedTile = bs.extraState.mahjongDiscards.splice(fIdx, 1)[0];
                      }
                    }
                    bs.extraState.lastDiscarded = null;
                  } else {
                    bs.extraState.lastDiscarded = null;
                  }
                  const meldTiles = resolvedGangType === 'ming' ? [...removedHandTiles, claimedTile] : [...removedHandTiles];
                  bs.extraState.mahjongMelds[seat].push({ type: 'gang', tile: claimedTile, tiles: meldTiles, seat, gangType: resolvedGangType });
                  p.tile = claimedTile;
                  p.meldTiles = meldTiles;
                }

                if ((room as any).deal?.remainingWall?.length > 0) {
                  const supp = (room as any).deal.remainingWall.pop();
                  if (supp && (room as any).deal.seatCards?.[seat]) {
                    (room as any).deal.seatCards[seat].push(supp);
                  }
                  if (supp && bs.handsCount && typeof bs.handsCount[seat] === 'number') {
                    bs.handsCount[seat] = Array.isArray(sCards) ? sCards.length : bs.handsCount[seat] + 1;
                  }
                  p.suppTile = supp || null;
                  bs.extraState.lastDrawnSeat = seat;
                  bs.extraState.lastDrawnTile = supp || null;
                }
                if (Array.isArray((room as any).deal?.remainingWall)) {
                  bs.extraState.wallRemaining = (room as any).deal.remainingWall.length;
                } else if (bs.extraState.wallRemaining > 0) {
                  bs.extraState.wallRemaining--;
                }
                p.wallRemaining = bs.extraState.wallRemaining;
                if (!bs.seatKongScores) bs.seatKongScores = [0, 0, 0, 0];
                const targetOpp =
                  resolvedGangType === 'ming' && typeof lastDisc?.discardBy === 'number'
                    ? lastDisc.discardBy
                    : p.fromSeat ?? p.targetSeat ?? p.discardBy;
                if (resolvedGangType === 'ming' && typeof targetOpp === 'number' && targetOpp >= 0 && targetOpp !== seat) {
                  p.fromSeat = targetOpp;
                  bs.seatKongScores[seat] += 10;
                  bs.seatKongScores[targetOpp] -= 10;
                } else {
                  for (let k = 0; k < 4; k++) {
                    if (k !== seat) bs.seatKongScores[k] -= 10;
                  }
                  bs.seatKongScores[seat] += 30;
                }
                p.seatKongScores = [...bs.seatKongScores];
                bs.turnSeat = seat;
                room.turnSeat = bs.turnSeat;
                room.moveCount = (room.moveCount || 0) + 1;
                bs.actionSeq = (bs.actionSeq || 0) + 1;
                bs.moveCount = room.moveCount;
                bs.updatedAt = Date.now();
                room.lastTurnTs = Date.now();
                bs.extraState.pendingPengSeat = seat;
                if (canceledDrawSeat !== null) {
                  p.canceledDrawSeat = canceledDrawSeat;
                  if (canceledDrawTile) p.canceledDrawTile = canceledDrawTile;
                }
              } else if (action === 'pass') {
                const cw = bs.extraState.claimWindow;
                if (cw && (!p.discardId || p.discardId === cw.discardId)) {
                  if (!cw.passedSeats.includes(seat)) {
                    cw.passedSeats.push(seat);
                  }
                  const stillPending = cw.pendingSeats.filter((ps: number) => !cw.passedSeats.includes(ps));
                  if (stillPending.length === 0) {
                    const nextTurnSeat = (cw.discarderSeat + 1) % 4;
                    const resolvedDiscardId = cw.discardId;
                    bs.extraState.claimWindow = null;
                    bs.turnSeat = nextTurnSeat;
                    room.turnSeat = nextTurnSeat;
                    room.moveCount = (room.moveCount || 0) + 1;
                    bs.actionSeq = (bs.actionSeq || 0) + 1;
                    bs.moveCount = room.moveCount;
                    bs.updatedAt = Date.now();
                    room.lastTurnTs = Date.now();

                    const wallArr = (room as any).deal?.remainingWall;
                    if (Array.isArray(wallArr) && wallArr.length === 0) {
                      executeMahjongDrawStalemate(room, nextTurnSeat, '牌墙抓毕，本局荒庄（流局）！');
                      return;
                    }
                    const crPayload = {
                      action: 'claim_resolved',
                      discardId: resolvedDiscardId,
                      nextTurn: nextTurnSeat,
                      wallRemaining: wallArr?.length ?? bs.extraState.wallRemaining,
                    };
                    broadcast({
                      type: 'game_event',
                      roomId: room.id,
                      seat: nextTurnSeat,
                      event: crPayload,
                      payload: crPayload,
                      moveCount: room.moveCount,
                      boardState: bs,
                    });
                  }
                  return;
                }
                if (p.nextTurn !== undefined && !cw) {
                  bs.turnSeat = Number(p.nextTurn);
                  room.turnSeat = bs.turnSeat;
                  room.moveCount = (room.moveCount || 0) + 1;
                  bs.actionSeq = (bs.actionSeq || 0) + 1;
                  bs.moveCount = room.moveCount;
                  bs.updatedAt = Date.now();
                } else {
                  return;
                }
              } else if (action === 'hu') {
                const sCards: any[] = (room as any).deal?.seatCards?.[seat] || [];
                const seatMelds = bs.extraState.mahjongMelds?.[seat] || [];
                const expectedTotal = sCards.length + seatMelds.length * 3;
                const hzCount = isHongzhongMode ? sCards.filter(isRedDragonTile).length : 0;
                const isFourHzAuth = isHongzhongMode && hzCount >= 4;
                const winRes = sCards.length % 3 === 2 ? checkMahjongWin(sCards as any, isHongzhongMode) : { win: false, desc: '', fan: 0 };

                if (expectedTotal !== 14 || sCards.length % 3 !== 2 || (!isFourHzAuth && !winRes.win)) {
                  console.warn(
                    `🛡️ [服务端防炸胡拦截] 席位 ${seat} 请求胡牌但手牌校验未通过 (手牌=${sCards.length}, 副露=${seatMelds.length}, 总计=${expectedTotal}, fourHz=${isFourHzAuth}, win=${winRes.win})`
                  );
                  sendMahjongReject('hu_rejected', 'invalid_hu_hand');
                  return;
                }
                if (bs.turnSeat !== seat && bs.extraState.pendingPengSeat !== seat) {
                  sendMahjongReject('hu_rejected', 'not_your_turn');
                  return;
                }

                room.moveCount = (room.moveCount || 0) + 1;
                bs.actionSeq = (bs.actionSeq || 0) + 1;
                bs.moveCount = room.moveCount;
                bs.updatedAt = Date.now();
                executeMahjongWinSettlement(room, seat, isFourHzAuth, p);
                return;
              } else if (action === 'draw_stalemate') {
                const wallArr = (room as any).deal?.remainingWall;
                if (Array.isArray(wallArr) && wallArr.length > 0) {
                  sendMahjongReject('draw_rejected', 'wall_not_empty');
                  return;
                }
                executeMahjongDrawStalemate(room, seat, '牌墙抓毕，本局荒庄（流局）！');
                return;
              }
            }
            // ==========================================
            // 2. 烟三权威裁决中枢
            // ==========================================
            else if (room.gameType === 'yansan') {
              if (!bs.extraState) bs.extraState = {};
              if (!bs.extraState.playedCardsHistory) bs.extraState.playedCardsHistory = [];
              if (!bs.extraState.seatPlayedCards) bs.extraState.seatPlayedCards = [[], [], [], []];
              if (!bs.extraState.playHistory) bs.extraState.playHistory = [];
              if (!bs.extraState.hasPassedSeats) bs.extraState.hasPassedSeats = [false, false, false, false];
              if (!bs.finishedSeats) bs.finishedSeats = [];

              const dealObj = (room as any).deal || {};
              const holders = detectYansanSpecialHolders(
                dealObj.initialSeatCards || dealObj.seatCards || [[], [], [], []],
                bs.extraState.seatPlayedCards
              );

              if (action === 'qianggong') {
                const seatInitial: any[] = dealObj.initialSeatCards?.[seat] || dealObj.seatCards?.[seat] || [];
                const holdsSpade3 = seatInitial.some((c: any) => c.rank === 3 && (c.suit === '♠' || c.suitVal === 4));
                const holdsSpadeA = seatInitial.some((c: any) => c.rank === 14 && (c.suit === '♠' || c.suitVal === 4));
                if (
                  bs.extraState.isQiangGongActive ||
                  bs.extraState.hasPassedSeats[seat] ||
                  !holdsSpade3 ||
                  !holdsSpadeA
                ) {
                  return;
                }

                bs.extraState.isQiangGongActive = true;
                bs.extraState.qiangGongSeat = seat;
                if (Array.isArray(dealObj.initialSeatCards)) {
                  dealObj.seatCards = dealObj.initialSeatCards.map((h: any[]) => [...h]);
                }
                let d4Seat = dealObj.starterSeat ?? 0;
                if (Array.isArray(dealObj.seatCards)) {
                  for (let s = 0; s < dealObj.seatCards.length; s++) {
                    if (dealObj.seatCards[s]?.some((c: any) => c.rank === 4 && (c.suit === '♦' || c.suitVal === 1))) {
                      d4Seat = s;
                      break;
                    }
                  }
                }
                bs.handsCount = [13, 13, 13, 13];
                bs.finishedSeats = [];
                bs.lastCombo = null;
                bs.discardsHistory = [];
                bs.extraState.playedCardsHistory = [];
                bs.extraState.seatPlayedCards = [[], [], [], []];
                bs.extraState.playHistory = [];
                bs.extraState.consecutivePasses = 0;
                bs.extraState.hasPassedSeats = [false, false, false, false];
                bs.turnSeat = d4Seat;
                room.turnSeat = d4Seat;
                room.moveCount = (room.moveCount || 0) + 1;
                bs.actionSeq = (bs.actionSeq || 0) + 1;
                bs.moveCount = room.moveCount;
                bs.updatedAt = Date.now();
                room.lastTurnTs = Date.now();

                const qgEvt = {
                  action: 'qianggong',
                  seat,
                  qiangGongSeat: seat,
                  starterSeat: d4Seat,
                  nextTurn: d4Seat,
                };
                broadcast({
                  type: 'game_event',
                  roomId: room.id,
                  seat,
                  event: qgEvt,
                  payload: qgEvt,
                  moveCount: room.moveCount,
                  boardState: bs,
                });
                return;
              }

              if (action === 'surrender') {
                const seatHand: any[] = dealObj.seatCards?.[seat] || [];
                const holdsSpade3 = seatHand.some((c: any) => c.rank === 3 && (c.suit === '♠' || c.suitVal === 4));
                const holdsSpadeA = seatHand.some((c: any) => c.rank === 14 && (c.suit === '♠' || c.suitVal === 4));
                if (
                  bs.extraState.isQiangGongActive ||
                  bs.extraState.hasPassedSeats[seat] ||
                  (Array.isArray(seatHand) && seatHand.length !== 13) ||
                  !holdsSpade3 ||
                  !holdsSpadeA
                ) {
                  return;
                }

                const stl = calculateYansanSurrenderSettlement(room.sceneMode || '5-10', seat);
                bs.winnerSeat = stl.winnerSeat;
                bs.phase = 'ended';
                room.status = 'finished';
                bs.allianceScoreResult = stl;
                bs.settlement = stl;
                room.moveCount = (room.moveCount || 0) + 1;
                bs.actionSeq = (bs.actionSeq || 0) + 1;
                bs.moveCount = room.moveCount;
                bs.updatedAt = Date.now();

                settleRoomCoins(room, stl.seatScores, 'yansan', {
                  ratingDeltaBySeat: stl.seatScores.map((pts) => Math.round(pts * 0.8)),
                });
                resetSceneRoomReadyAndCleanDisconnected(room.id);

                const surEvt = {
                  action: 'surrender',
                  seat,
                  winner: stl.winnerSeat,
                  finishedSeats: [stl.winnerSeat],
                  allianceScoreResult: stl,
                  fromServerSettlement: true,
                };
                broadcast({
                  type: 'game_event',
                  roomId: room.id,
                  seat,
                  event: surEvt,
                  payload: surEvt,
                  moveCount: room.moveCount,
                  boardState: bs,
                });
                return;
              }

              if (action === 'finish' || (p.winner !== undefined && p.winner !== null)) {
                if (Array.isArray(p.finishedSeats)) {
                  bs.finishedSeats = [...p.finishedSeats];
                }
                resolveYansanFinish(room, Number(p.winner ?? seat), holders);
                return;
              }

              if (action === 'play') {
                if (typeof bs.turnSeat === 'number' && bs.turnSeat !== seat) {
                  return;
                }
                const cardsToPlay: YansanCard[] = combo?.cards || [];
                const parsed = parseYansanCombo(cardsToPlay);
                const serverHand: any[] | undefined = dealObj.seatCards?.[seat];
                if (!parsed || (Array.isArray(serverHand) && !cardsToPlay.every((c) => serverHand.some((h) => h.id === c.id)))) {
                  return;
                }
                const activeTarget = bs.lastCombo && bs.lastCombo.seat !== seat ? bs.lastCombo : null;
                if (activeTarget && !canBeatYansanCombo(parsed, activeTarget)) {
                  return;
                }
                const hasAnyCardsPlayed = (bs.extraState.playedCardsHistory || []).length > 0;
                if (!hasAnyCardsPlayed) {
                  const hasD4 = cardsToPlay.some((c) => c.rank === 4 && (c.suit === '♦' || c.suitVal === 1));
                  if (
                    Array.isArray(serverHand) &&
                    serverHand.some((c: any) => c.rank === 4 && (c.suit === '♦' || c.suitVal === 1)) &&
                    !hasD4
                  ) {
                    return;
                  }
                }

                const primaryCard = parsed.cards[0] || cardsToPlay[0];
                const isTier3Or4 = parsed.type === '5_card' && (parsed.comboTier === 3 || parsed.comboTier === 4);
                const resolvedSuitVal = parsed.suitVal || primaryCard?.suitVal || 1;
                const authoritativeCombo = {
                  ...parsed,
                  seat,
                  primaryRank: parsed.rank,
                  primarySuitVal: isTier3Or4 ? 0 : getYansanRankWeight(parsed.rank) * 10 + resolvedSuitVal,
                  flushSuit: (parsed.comboTier === 2 || parsed.comboTier === 5) ? resolvedSuitVal : undefined,
                };
                room.moveCount = (room.moveCount || 0) + 1;
                bs.actionSeq = (bs.actionSeq || 0) + 1;
                bs.moveCount = room.moveCount;
                bs.updatedAt = Date.now();
                room.lastTurnTs = Date.now();

                bs.lastCombo = authoritativeCombo;
                if (!bs.discardsHistory) bs.discardsHistory = [];
                bs.discardsHistory.push(authoritativeCombo);
                if (bs.discardsHistory.length > 100) bs.discardsHistory = bs.discardsHistory.slice(-100);
                bs.extraState.playedCardsHistory.push(...cardsToPlay);
                if (!bs.extraState.seatPlayedCards[seat]) bs.extraState.seatPlayedCards[seat] = [];
                bs.extraState.seatPlayedCards[seat].push(...cardsToPlay);
                bs.extraState.playHistory.push({
                  seat,
                  cards: cardsToPlay,
                  combo: authoritativeCombo,
                  targetCombo: activeTarget,
                  isPass: false,
                  actionSeq: bs.actionSeq,
                  timestamp: Date.now(),
                });
                bs.extraState.consecutivePasses = 0;

                if (Array.isArray(serverHand)) {
                  const playedIds = new Set(cardsToPlay.map((c: any) => c.id));
                  dealObj.seatCards[seat] = serverHand.filter((c: any) => !playedIds.has(c.id));
                  bs.handsCount[seat] = dealObj.seatCards[seat].length;
                } else if (seat < bs.handsCount.length) {
                  bs.handsCount[seat] = Math.max(0, bs.handsCount[seat] - cardsToPlay.length);
                }

                if (bs.handsCount[seat] === 0 && !bs.finishedSeats.includes(seat)) {
                  bs.finishedSeats.push(seat);
                }

                const totalSeats = bs.handsCount?.length || 4;
                const finished = bs.finishedSeats || [];
                let nextSeat = (seat - 1 + totalSeats) % totalSeats;
                let guard = 0;
                while (finished.includes(nextSeat) && guard < totalSeats) {
                  nextSeat = (nextSeat - 1 + totalSeats) % totalSeats;
                  guard++;
                }

                const isQG = Boolean(bs.extraState.isQiangGongActive);
                const is2v2 = holders.spade3Seat !== holders.spadeASeat;
                let shouldEnd = false;
                if (isQG) {
                  shouldEnd = finished.length >= 1;
                } else if (is2v2) {
                  const isSpade = (s: number) => s === holders.spade3Seat || s === holders.spadeASeat;
                  if (finished.length >= 2 && isSpade(finished[0]) === isSpade(finished[1])) {
                    shouldEnd = true;
                  } else if (finished.length >= 3) {
                    shouldEnd = true;
                  }
                } else {
                  if (finished[0] === holders.soloSeat || finished.length >= 3) {
                    shouldEnd = true;
                  }
                }

                let resolvedNextTurn = nextSeat;
                let unbeatableAutoClear = false;
                if (!shouldEnd) {
                  const playedIdsAll = new Set((bs.extraState.playedCardsHistory || []).map((c: any) => c.id));
                  const availablePool = createYansanStandardDeck().filter((c) => !playedIdsAll.has(c.id));
                  let maxOppCards = 0;
                  for (let sIdx = 0; sIdx < totalSeats; sIdx++) {
                    if (sIdx !== seat && !finished.includes(sIdx)) {
                      maxOppCards = Math.max(maxOppCards, Number(bs.handsCount?.[sIdx] || 0));
                    }
                  }
                  const isDeductivelyUnbeatable = isYansanComboDeductivelyUnbeatable(parsed, availablePool, maxOppCards);
                  const hasSpade3 = cardsToPlay.some((c) => c.rank === 3 && (c.suit === '♠' || c.suitVal === 4));
                  if (bs.handsCount[seat] === 0 && (isDeductivelyUnbeatable || hasSpade3)) {
                    bs.lastCombo = null;
                    bs.extraState.consecutivePasses = 0;
                    resolvedNextTurn = nextSeat;
                    unbeatableAutoClear = true;
                  } else if (bs.handsCount[seat] > 0 && isDeductivelyUnbeatable) {
                    bs.lastCombo = null;
                    bs.extraState.consecutivePasses = 0;
                    resolvedNextTurn = seat;
                    unbeatableAutoClear = true;
                  }
                }
                bs.turnSeat = resolvedNextTurn;
                room.turnSeat = resolvedNextTurn;

                const playEvt = {
                  ...p,
                  action: 'play',
                  seat,
                  combo: authoritativeCombo,
                  nextTurn: resolvedNextTurn,
                  finishedSeats: bs.finishedSeats,
                  unbeatableAutoClear: unbeatableAutoClear || undefined,
                };
                broadcast({
                  type: 'game_event',
                  roomId: room.id,
                  seat,
                  event: playEvt,
                  payload: playEvt,
                  moveCount: room.moveCount,
                  boardState: bs,
                });

                if (shouldEnd) {
                  resolveYansanFinish(room, finished[0] ?? seat, holders);
                }
                return;
              }

              if (action === 'pass') {
                if (typeof bs.turnSeat === 'number' && bs.turnSeat !== seat) {
                  return;
                }
                if (!bs.lastCombo || bs.lastCombo.seat === seat) {
                  return;
                }
                room.moveCount = (room.moveCount || 0) + 1;
                bs.actionSeq = (bs.actionSeq || 0) + 1;
                bs.moveCount = room.moveCount;
                bs.updatedAt = Date.now();
                room.lastTurnTs = Date.now();

                bs.extraState.hasPassedSeats[seat] = true;
                bs.extraState.consecutivePasses = (bs.extraState.consecutivePasses || 0) + 1;
                bs.extraState.playHistory.push({
                  seat,
                  cards: [],
                  combo: null,
                  targetCombo: bs.lastCombo,
                  isPass: true,
                  actionSeq: bs.actionSeq,
                  timestamp: Date.now(),
                });

                const totalSeats = bs.handsCount?.length || 4;
                const finished = bs.finishedSeats || [];
                const activeCount = Math.max(1, totalSeats - finished.length);
                const lastLeader = bs.lastCombo?.seat;
                const leaderFinished = lastLeader !== undefined && finished.includes(lastLeader);
                const passThreshold = leaderFinished ? activeCount : Math.max(1, activeCount - 1);
                if (bs.extraState.consecutivePasses >= passThreshold) {
                  bs.lastCombo = null;
                  bs.extraState.consecutivePasses = 0;
                }

                let nextSeat = (seat - 1 + totalSeats) % totalSeats;
                let guard = 0;
                while (finished.includes(nextSeat) && guard < totalSeats) {
                  nextSeat = (nextSeat - 1 + totalSeats) % totalSeats;
                  guard++;
                }
                const resolvedNextTurn = nextSeat;
                bs.turnSeat = resolvedNextTurn;
                room.turnSeat = resolvedNextTurn;

                const passEvt = {
                  ...p,
                  action: 'pass',
                  seat,
                  nextTurn: resolvedNextTurn,
                  finishedSeats: bs.finishedSeats,
                };
                broadcast({
                  type: 'game_event',
                  roomId: room.id,
                  seat,
                  event: passEvt,
                  payload: passEvt,
                  moveCount: room.moveCount,
                  boardState: bs,
                });
                return;
              }
            }
            // ==========================================
            // 3. 十三张 / 十三水权威裁决中枢
            // ==========================================
            else if (action === 'shisanshui_submit_hand') {
              if (bs.shisanshuiSubmissions?.[seat]) {
                return;
              }
              const headArr = p.tiers?.head || p.rawTiers?.front;
              const midArr = p.tiers?.mid || p.rawTiers?.mid;
              const tailArr = p.tiers?.tail || p.rawTiers?.back;
              if (
                !Array.isArray(headArr) ||
                headArr.length !== 3 ||
                !Array.isArray(midArr) ||
                midArr.length !== 5 ||
                !Array.isArray(tailArr) ||
                tailArr.length !== 5
              ) {
                return;
              }
              const submittedIds = [...headArr, ...midArr, ...tailArr].map((c: any) => c?.id).filter(Boolean);
              const uniqueSubmitted = new Set(submittedIds);
              if (uniqueSubmitted.size !== 13) {
                return;
              }
              const authSeatCards: any[] | undefined = (room as any).deal?.seatCards?.[seat];
              const cardMap = new Map<string, any>();
              if (Array.isArray(authSeatCards) && authSeatCards.length === 13) {
                for (const ac of authSeatCards) cardMap.set(ac.id, ac);
                if (!submittedIds.every((id) => cardMap.has(id))) {
                  return;
                }
              }
              const reconstruct = (arr: any[]) =>
                arr.map((c: any) => cardMap.get(c.id) || c);
              const suitValMap: Record<string, number> = { '♠': 4, '♥': 3, '♣': 2, '♦': 1 };
              const toSss = (c: any): SSSCard => ({
                id: c.id,
                rank: Number(c.rank),
                suitVal: typeof c.suitVal === 'number' ? c.suitVal : (suitValMap[c.suit] || 1),
                label: c.label,
                suit: c.suit,
                isRed: Boolean(c.isRed),
              });
              const authHeadRaw = reconstruct(headArr);
              const authMidRaw = reconstruct(midArr);
              const authBackRaw = reconstruct(tailArr);
              const sssHead = authHeadRaw.map(toSss);
              const sssMid = authMidRaw.map(toSss);
              const sssBack = authBackRaw.map(toSss);
              const serverSpecial = detectSpecialHand([...sssHead, ...sssMid, ...sssBack]);
              if (!serverSpecial && isFoulHand(sssHead, sssMid, sssBack)) {
                ws.send(
                  JSON.stringify({
                    type: 'game_event',
                    roomId: room.id,
                    seat,
                    event: {
                      action: 'shisanshui_submit_rejected',
                      reason: 'foul_hand',
                      message: '当前摆牌倒水相公（尾道需 >= 中道 >= 头道），请调整后提交',
                    },
                    boardState: bs,
                  })
                );
                return;
              }

              if (!bs.shisanshuiSubmissions) {
                bs.shisanshuiSubmissions = {};
              }
              bs.shisanshuiSubmissions[seat] = {
                seat,
                tiers: { head: sssHead, mid: sssMid, tail: sssBack },
                rawTiers: {
                  front: authHeadRaw,
                  mid: authMidRaw,
                  back: authBackRaw,
                  frontLabel: evaluate3CardTier(sssHead).name,
                  midLabel: evaluate5CardTier(sssMid).name,
                  backLabel: evaluate5CardTier(sssBack).name,
                  specialHand: serverSpecial,
                },
                isSpecial: Boolean(serverSpecial),
                submittedAt: Date.now(),
              };
              const submittedCount = Object.keys(bs.shisanshuiSubmissions).length;
              const targetCount = room.players?.length || (room.sceneMode?.includes('eight') ? 8 : 4);
              bs.actionSeq = (bs.actionSeq || 0) + 1;
              bs.updatedAt = Date.now();

              broadcast({
                type: 'game_event',
                roomId: room.id,
                seat,
                event: {
                  action: 'shisanshui_submit_hand',
                  seat,
                  submittedCount,
                  targetCount,
                  isSpecial: Boolean(serverSpecial),
                },
                payload: {
                  action: 'shisanshui_submit_hand',
                  seat,
                  submittedCount,
                  targetCount,
                  isSpecial: Boolean(serverSpecial),
                },
                boardState: bs,
              });

              if (submittedCount >= targetCount) {
                settleShisanshuiRound(room, false);
              }
              return;
            } else {
              room.moveCount = (room.moveCount || 0) + 1;
              bs.actionSeq = (bs.actionSeq || 0) + 1;
              bs.moveCount = room.moveCount;
              bs.updatedAt = Date.now();
              room.lastTurnTs = Date.now();

              if (p.multiplier) bs.multiplier = Number(p.multiplier);
              if (p.nextTurn !== undefined) {
                bs.turnSeat = Number(p.nextTurn);
                room.turnSeat = bs.turnSeat;
              }
              if (combo) {
                bs.lastCombo = combo;
                if (!bs.discardsHistory) bs.discardsHistory = [];
                bs.discardsHistory.push(combo);
                if (bs.discardsHistory.length > 100) bs.discardsHistory = bs.discardsHistory.slice(-100);
              }
            }

            if (p.action === 'finish' || (p.winner !== undefined && p.winner !== null)) {
              bs.winnerSeat = p.winner !== undefined && p.winner !== null ? Number(p.winner) : null;
              bs.phase = 'ended';
              room.status = 'finished';
              if (p.finishedSeats && Array.isArray(p.finishedSeats)) {
                bs.finishedSeats = [...p.finishedSeats];
              }
              if (p.allianceScoreResult) {
                bs.allianceScoreResult = p.allianceScoreResult;
                bs.settlement = p.allianceScoreResult;
              }
              resetSceneRoomReadyAndCleanDisconnected(room.id);
            }

            const resolvedNextTurn = p.nextTurn !== undefined ? Number(p.nextTurn) : bs.turnSeat;
            if (room.gameType === 'mahjong') {
              sendSanitizedToRoom(room, (rSeat) => {
                const maskedEvt: any = {
                  action,
                  seat,
                  combo,
                  nextTurn: resolvedNextTurn,
                  winner: bs.winnerSeat ?? p.winner,
                  finishedSeats: bs.finishedSeats || p.finishedSeats,
                  allianceScoreResult: bs.allianceScoreResult || p.allianceScoreResult,
                  ...p,
                };
                if (action === 'draw' && rSeat !== seat && maskedEvt.tile) {
                  maskedEvt.tile = maskHiddenMahjongTile(maskedEvt.tile);
                }
                if (action === 'gang' && rSeat !== seat && maskedEvt.suppTile) {
                  maskedEvt.suppTile = maskHiddenMahjongTile(maskedEvt.suppTile);
                }
                if (maskedEvt.canceledDrawTile && rSeat !== maskedEvt.canceledDrawSeat) {
                  maskedEvt.canceledDrawTile = maskHiddenMahjongTile(maskedEvt.canceledDrawTile);
                }
                return {
                  type: 'game_event',
                  roomId: room.id,
                  seat,
                  event: maskedEvt,
                  payload: maskedEvt,
                  moveCount: room.moveCount,
                  boardState: sanitizeBoardStateForSeat(bs, 'mahjong', rSeat),
                };
              });
            } else {
              broadcast({
                type: 'game_event',
                roomId: room.id,
                seat,
                event: {
                  action,
                  seat,
                  combo,
                  nextTurn: resolvedNextTurn,
                  winner: bs.winnerSeat ?? p.winner,
                  finishedSeats: bs.finishedSeats || p.finishedSeats,
                  allianceScoreResult: bs.allianceScoreResult || p.allianceScoreResult,
                  ...p,
                },
                payload: {
                  action,
                  seat,
                  combo,
                  nextTurn: resolvedNextTurn,
                  winner: bs.winnerSeat ?? p.winner,
                  finishedSeats: bs.finishedSeats || p.finishedSeats,
                  allianceScoreResult: bs.allianceScoreResult || p.allianceScoreResult,
                  ...p,
                },
                moveCount: room.moveCount,
                boardState: bs,
              });
            }
          }
          return;
        }

        if (msg.type === 'game_chat' || msg.type === 'room_voice') {
          const targetRoomId = msg.roomId || 'RM-202';
          const room = rooms.get(targetRoomId);
          if (msg.text || msg.audio) {
            const chatMsg = {
              id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              sender: msg.sender || '牌友',
              senderId: msg.senderId || null,
              avatar: msg.avatar || '👤',
              text: msg.text ? String(msg.text).slice(0, 100) : msg.audio ? '🎤 [牌桌实时语音]' : '',
              prop: msg.prop || null,
              targetSeat: msg.targetSeat !== undefined ? msg.targetSeat : null,
              voice: Boolean(msg.voice),
              audio: msg.audio || null,
              duration: Number(msg.duration) || 0,
              timestamp: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
            };
            if (room) {
              room.chat = [...room.chat.slice(-49), chatMsg];
            }
            broadcast({ type: 'chat_broadcast', roomId: targetRoomId, message: chatMsg });
          }
          return;
        }
      } catch {}
    });
  });

  // Periodic WebSocket zombie client heartbeat sweep
  setInterval(() => {
    const now = Date.now();
    for (const client of wss.clients) {
      const wsAny = client as any;
      if (wsAny.lastHeartbeat && now - wsAny.lastHeartbeat > 60000) {
        client.terminate();
      } else {
        wsAny.isAlive = false;
        try {
          client.ping();
        } catch {}
      }
    }
  }, 25000);

  // Authoritative AFK & Settlement Timeout Watchdog
  setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      // 0. 结算超时仲裁：未在规定时间内点击“继续下一局”的真实玩家自动清出房间并返回大厅
      if ((room.status === 'finished' || room.boardState?.phase === 'ended') && room.settlementExpiresAt && now >= room.settlementExpiresAt) {
        const sceneRoom = sceneWaitingRooms.get(room.id);
        const currentPlayers = sceneRoom?.players || room.players || [];
        const timedOutPlayers = currentPlayers.filter((p: any) => !isBotLikePlayer(p) && !p.isReady);
        const readyPlayers = currentPlayers.filter((p: any) => !isBotLikePlayer(p) && p.isReady);
        const timedOutIds = timedOutPlayers.map((p: any) => p.id);
        const timedOutSeats = timedOutPlayers.map((p: any) => p.seat);

        if (timedOutIds.length > 0) {
          console.log(`⏱️ [结算超时踢出] 房间 ${room.id} 结算倒计时结束，自动返回大厅玩家: ${timedOutIds.join(',')}`);
          broadcast({
            type: 'settlement_timeout',
            roomId: room.id,
            gameType: room.gameType,
            timedOutPlayerIds: timedOutIds,
            timedOutSeats,
            message: '结算超时未点击继续下一局，已自动返回大厅',
          });
        }

        delete room.settlementExpiresAt;
        if (sceneRoom) delete (sceneRoom as any).settlementExpiresAt;

        if (readyPlayers.length === 0) {
          sceneWaitingRooms.delete(room.id);
          rooms.delete(room.id);
        } else {
          readyPlayers.forEach((p: any) => {
            p.isReady = true;
          });
          if (sceneRoom) {
            sceneRoom.players = readyPlayers;
            sceneRoom.status = 'finished';
          }
          room.players = readyPlayers.map((p: any) => ({ ...p }));
          room.status = 'finished';
          broadcast({
            type: 'scene_room_update',
            roomId: room.id,
            gameType: room.gameType,
            sceneMode: room.sceneMode || sceneRoom?.sceneMode || '',
            players: room.players,
            maxPlayers: room.maxPlayers || sceneRoom?.maxPlayers || 4,
            status: 'finished',
          });
        }
        continue;
      }

      if (room.status !== 'playing' || !room.boardState || room.boardState.phase !== 'playing') continue;

      // 1. 十三张超时保底结算（若剩余未交牌者全为机器人或离线托管，直接代为最优理牌并结算）
      if (room.gameType === 'shisanshui') {
        const subs = room.boardState.shisanshuiSubmissions || {};
        const totalP = room.players?.length || (room.sceneMode?.includes('eight') ? 8 : 4);
        const submittedCount = Object.keys(subs).length;
        let onlyAutoRemaining = submittedCount > 0 && submittedCount < totalP;
        if (onlyAutoRemaining) {
          for (let s = 0; s < totalP; s++) {
            if (subs[s]) continue;
            const pl = room.players?.find((x: any, idx: number) => (typeof x?.seat === 'number' ? x.seat : idx) === s);
            if (pl && !isBotLikePlayer(pl) && !pl.isDisconnected && !pl.isAutoManaged) {
              onlyAutoRemaining = false;
              break;
            }
          }
        }
        if (onlyAutoRemaining || (room.lastTurnTs && now - room.lastTurnTs > 60000)) {
          room.lastTurnTs = now;
          settleShisanshuiRound(room, !onlyAutoRemaining);
        }
        continue;
      }

      // 2. 麻将碰杠抢答窗口超时仲裁 (10.5s 自动结算窗口，并核查牌墙是否已空)
      if (room.gameType === 'mahjong' && room.boardState.extraState?.claimWindow) {
        const cw = room.boardState.extraState.claimWindow;
        if (now - cw.createdAt > 10500) {
          const nextTurnSeat = (cw.discarderSeat + 1) % 4;
          const resolvedDiscardId = cw.discardId;
          room.boardState.extraState.claimWindow = null;
          room.boardState.turnSeat = nextTurnSeat;
          room.turnSeat = nextTurnSeat;
          room.lastTurnTs = now;
          room.moveCount = (room.moveCount || 0) + 1;
          room.boardState.actionSeq = (room.boardState.actionSeq || 0) + 1;
          room.boardState.moveCount = room.moveCount;
          room.boardState.updatedAt = now;

          const wallArr = (room as any).deal?.remainingWall;
          if (Array.isArray(wallArr) && wallArr.length === 0) {
            executeMahjongDrawStalemate(room, nextTurnSeat, '牌墙抓毕，本局荒庄（流局）！');
          } else {
            const crPayload = {
              action: 'claim_resolved',
              discardId: resolvedDiscardId,
              nextTurn: nextTurnSeat,
              wallRemaining: wallArr?.length ?? room.boardState.extraState.wallRemaining,
              timeout: true,
            };
            broadcast({
              type: 'game_event',
              roomId: room.id,
              seat: nextTurnSeat,
              event: crPayload,
              payload: crPayload,
              moveCount: room.moveCount,
              boardState: room.boardState,
            });
          }
        }
        continue;
      }

      const currentSeat = room.turnSeat || 0;
      const curPlayer = room.players?.find((p: any) => p.seat === currentSeat);
      const isPlayerAuto = Boolean(
        curPlayer?.isAutoManaged ||
          curPlayer?.isDisconnected ||
          isBotLikePlayer(curPlayer) ||
          (room.boardState?.autoManagedSeats && room.boardState.autoManagedSeats[currentSeat])
      );
      const isConnectedManualAuto = Boolean(isPlayerAuto && !curPlayer?.isDisconnected && !isBotLikePlayer(curPlayer));
      const mjDealForThreshold = (room as any).deal;
      const mjWallEmptyPendingDraw =
        room.gameType === 'mahjong' &&
        Array.isArray(mjDealForThreshold?.remainingWall) &&
        mjDealForThreshold.remainingWall.length === 0 &&
        !room.boardState.extraState?.pendingPengSeat;
      const baseTimeoutThreshold = isConnectedManualAuto ? 2600 : isPlayerAuto ? 1200 : 60000;
      const isYansanBaoDan =
        room.gameType === 'yansan' &&
        Array.isArray((room as any).deal?.seatCards?.[currentSeat]) &&
        (room as any).deal.seatCards[currentSeat].length === 1;
      const timeoutThreshold = mjWallEmptyPendingDraw
        ? Math.min(baseTimeoutThreshold, 3500)
        : isYansanBaoDan
          ? Math.min(baseTimeoutThreshold, 2500)
          : baseTimeoutThreshold;

      if (!room.lastTurnTs || now - room.lastTurnTs <= timeoutThreshold) continue;
      room.lastTurnTs = now;

      if (!isPlayerAuto && !mjWallEmptyPendingDraw) {
        if (curPlayer) curPlayer.isAutoManaged = true;
        if (!room.boardState.autoManagedSeats) room.boardState.autoManagedSeats = {};
        room.boardState.autoManagedSeats[currentSeat] = true;
        broadcast({
          type: 'game_event',
          roomId: room.id,
          seat: currentSeat,
          event: { action: 'set_auto_host', seat: currentSeat, absSeat: currentSeat, isAutoManaged: true, isAutoHost: true },
          payload: { action: 'set_auto_host', seat: currentSeat, absSeat: currentSeat, isAutoManaged: true, isAutoHost: true },
          boardState: room.boardState,
        });
      }

      // 3. 麻将托管摸打推演
      if (room.gameType === 'mahjong') {
        let deal = (room as any).deal;
        const isHongzhongMode = room.sceneMode?.includes('hongzhong') ?? true;

        if (!deal || !deal.seatCards) {
          deal = generateRoomDeal(room.gameType, room.sceneMode, 4);
          (room as any).deal = deal;
        }
        if (!deal.seatCards[currentSeat]) {
          deal.seatCards[currentSeat] = [];
        }

        const hand: any[] = deal.seatCards[currentSeat];
        const wall: any[] = deal.remainingWall || [];
        const melds = room.boardState.extraState?.mahjongMelds?.[currentSeat] || [];

        const totalTiles = hand.length + melds.length * 3;
        if (totalTiles % 3 === 1) {
          if (wall.length === 0) {
            executeMahjongDrawStalemate(room, currentSeat, '牌墙已摸空，荒牌流局！');
            continue;
          }

          const drawnTile = wall.shift()!;
          hand.push(drawnTile);
          if (!room.boardState.extraState) room.boardState.extraState = {};
          room.boardState.extraState.wallRemaining = wall.length;
          room.boardState.extraState.lastDrawnSeat = currentSeat;
          room.boardState.extraState.lastDrawnTile = drawnTile;
          room.boardState.actionSeq = (room.boardState.actionSeq || 0) + 1;
          if (room.boardState.handsCount) room.boardState.handsCount[currentSeat] = hand.length;

          sendSanitizedToRoom(room, (rSeat) => {
            const tileForSeat = rSeat === currentSeat ? drawnTile : maskHiddenMahjongTile(drawnTile);
            const drawEvt = {
              action: 'draw',
              seat: currentSeat,
              absSeat: currentSeat,
              tile: tileForSeat,
              wallRemaining: wall.length,
              autoDraw: true,
              moveCount: room.moveCount,
            };
            return {
              type: 'game_event',
              roomId: room.id,
              seat: currentSeat,
              moveCount: room.moveCount,
              event: drawEvt,
              payload: drawEvt,
              boardState: sanitizeBoardStateForSeat(room.boardState, 'mahjong', rSeat),
            };
          });

          const redDragonCount = isHongzhongMode
            ? hand.filter((t: any) => t.type === 'zi' && (t.value === 5 || t.text === '红中' || t.isRedDragon)).length
            : 0;
          const isFourHz = isHongzhongMode && redDragonCount >= 4;
          const winRes =
            hand.length % 3 === 2 && hand.length + melds.length * 3 === 14
              ? checkMahjongWin(hand as any, isHongzhongMode)
              : { win: false, desc: '', fan: 0 };

          if (hand.length + melds.length * 3 === 14 && (isFourHz || winRes.win)) {
            executeMahjongWinSettlement(room, currentSeat, isFourHz, { tile: drawnTile });
            continue;
          }
        }

        let discardIdx = 0;
        const nonHzTiles = isHongzhongMode
          ? hand
              .map((t, idx) => ({ t, idx }))
              .filter((item) => !(item.t.type === 'zi' && (item.t.value === 5 || item.t.text === '红中' || item.t.isRedDragon)))
          : hand.map((t, idx) => ({ t, idx }));

        if (nonHzTiles.length > 0) {
          const ziSingles = nonHzTiles.filter((item) => {
            if (item.t.type !== 'zi') return false;
            return hand.filter((x) => x.type === 'zi' && x.value === item.t.value).length === 1;
          });
          if (ziSingles.length > 0) {
            discardIdx = ziSingles[0].idx;
          } else {
            const isolatedNum = nonHzTiles.filter((item) => {
              if (item.t.type === 'zi') return false;
              const hasSame = hand.filter((x) => x.type === item.t.type && x.value === item.t.value).length > 1;
              const hasNeighbour = hand.some(
                (x) => x.type === item.t.type && Math.abs(x.value - item.t.value) <= 2 && x.id !== item.t.id
              );
              return !hasSame && !hasNeighbour;
            });
            discardIdx = isolatedNum.length > 0 ? isolatedNum[0].idx : nonHzTiles[nonHzTiles.length - 1].idx;
          }
        }

        const [discardedTile] = hand.splice(discardIdx >= 0 && discardIdx < hand.length ? discardIdx : Math.max(0, hand.length - 1), 1);
        const nextSeat = (currentSeat + 1) % 4;
        room.turnSeat = nextSeat;
        room.boardState.turnSeat = nextSeat;
        room.boardState.updatedAt = now;
        room.moveCount = (room.moveCount || 0) + 1;
        room.boardState.actionSeq = (room.boardState.actionSeq || 0) + 1;
        room.boardState.moveCount = room.moveCount;
        room.lastTurnTs = now;

        if (!room.boardState.extraState) room.boardState.extraState = {};
        if (!room.boardState.extraState.mahjongDiscards) room.boardState.extraState.mahjongDiscards = [];

        const discTile = { ...discardedTile, discardBy: currentSeat };
        room.boardState.extraState.mahjongDiscards.push(discTile);
        room.boardState.extraState.lastDiscarded = discTile;
        room.boardState.extraState.pendingPengSeat = null;
        room.boardState.extraState.lastDrawnSeat = null;
        room.boardState.extraState.lastDrawnTile = null;
        room.boardState.extraState.wallRemaining = wall.length;

        const pendingClaimSeats = computeMahjongClaimPendingSeats(room, room.boardState, currentSeat, discTile);
        if (pendingClaimSeats.length > 0) {
          room.boardState.extraState.claimWindow = {
            discardId: discTile.id,
            discarderSeat: currentSeat,
            pendingSeats: pendingClaimSeats,
            passedSeats: [],
            createdAt: now,
          };
        } else {
          room.boardState.extraState.claimWindow = null;
        }

        if (room.boardState.handsCount) {
          room.boardState.handsCount[currentSeat] = hand.length;
        }

        const autoDiscEvt = {
          action: 'discard',
          seat: currentSeat,
          absSeat: currentSeat,
          tile: discTile,
          autoDiscard: true,
          nextTurn: nextSeat,
          wallRemaining: wall.length,
          pendingClaimSeats,
          hasClaimWindow: pendingClaimSeats.length > 0,
          reason: 'trustee_auto_discard',
        };
        broadcast({
          type: 'game_event',
          roomId: room.id,
          seat: currentSeat,
          event: autoDiscEvt,
          payload: autoDiscEvt,
          moveCount: room.moveCount,
          boardState: room.boardState,
        });

        if (pendingClaimSeats.length === 0) {
          if (wall.length === 0) {
            executeMahjongDrawStalemate(room, nextSeat, '牌墙已摸空，荒牌流局！');
          } else {
            room.boardState.actionSeq = (room.boardState.actionSeq || 0) + 1;
            const crPayload = {
              action: 'claim_resolved',
              discardId: discTile?.id || null,
              nextTurn: nextSeat,
              wallRemaining: wall.length,
            };
            broadcast({
              type: 'game_event',
              roomId: room.id,
              seat: nextSeat,
              event: crPayload,
              payload: crPayload,
              moveCount: room.moveCount,
              boardState: room.boardState,
            });
          }
        }
        continue;
      }

      // 4. 烟三智能服务端超时出牌推演 (完全基于真实手牌与 SmartAI，绝不伪造虚构牌)
      const totalSeats = room.boardState.handsCount?.length || 4;
      const finished: number[] = Array.isArray(room.boardState.finishedSeats) ? room.boardState.finishedSeats : [];
      const bs = room.boardState;
      const seatHand: YansanCard[] = Array.isArray((room as any).deal?.seatCards?.[currentSeat])
        ? (room as any).deal.seatCards[currentSeat]
        : [];
      if (seatHand.length === 0) continue;

      if (!bs.extraState) bs.extraState = {};
      if (!bs.extraState.seatPlayedCards) bs.extraState.seatPlayedCards = [[], [], [], []];
      if (!bs.extraState.playHistory) bs.extraState.playHistory = [];
      if (!bs.extraState.hasPassedSeats) bs.extraState.hasPassedSeats = [false, false, false, false];

      const isAbsoluteFirst = room.moveCount === 0 && (bs.extraState.playedCardsHistory || []).length === 0;
      const targetCombo = bs.lastCombo && bs.lastCombo.seat !== currentSeat ? bs.lastCombo : null;
      const aiRes = getYansanSmartAIPlay(seatHand, targetCombo, {
        isFirstTurn: isAbsoluteFirst,
        seat: currentSeat,
        handsCount: bs.handsCount,
        seatPlayedCards: bs.extraState.seatPlayedCards,
        playHistory: bs.extraState.playHistory,
        isQiangGong: Boolean(bs.extraState.isQiangGongActive),
        qiangGongSeat: bs.extraState.qiangGongSeat ?? null,
      });

      let nextSeat = (currentSeat - 1 + totalSeats) % totalSeats;
      let stepGuard = 0;
      while (finished.includes(nextSeat) && stepGuard < totalSeats) {
        nextSeat = (nextSeat - 1 + totalSeats) % totalSeats;
        stepGuard++;
      }

      const parsedAiCombo = aiRes.cards && aiRes.cards.length > 0 ? parseYansanCombo(aiRes.cards) : null;
      const canPlayAi = Boolean(parsedAiCombo && (!targetCombo || canBeatYansanCombo(parsedAiCombo, targetCombo)));

      if (canPlayAi && parsedAiCombo) {
        room.moveCount = (room.moveCount || 0) + 1;
        bs.moveCount = room.moveCount;
        bs.actionSeq = (bs.actionSeq || 0) + 1;
        bs.updatedAt = now;

        const playedIds = new Set(parsedAiCombo.cards.map((c) => c.id));
        (room as any).deal.seatCards[currentSeat] = seatHand.filter((c) => !playedIds.has(c.id));

        const primaryCard = parsedAiCombo.cards[0];
        const isTier3Or4 = parsedAiCombo.type === '5_card' && (parsedAiCombo.comboTier === 3 || parsedAiCombo.comboTier === 4);
        const resolvedSuitVal = parsedAiCombo.suitVal || primaryCard?.suitVal || 1;
        const authoritativeCombo = {
          ...parsedAiCombo,
          seat: currentSeat,
          primaryRank: parsedAiCombo.rank,
          primarySuitVal: isTier3Or4 ? 0 : getYansanRankWeight(parsedAiCombo.rank) * 10 + resolvedSuitVal,
          flushSuit: (parsedAiCombo.comboTier === 2 || parsedAiCombo.comboTier === 5) ? resolvedSuitVal : undefined,
        };
        bs.lastCombo = authoritativeCombo;
        if (!bs.extraState.playedCardsHistory) bs.extraState.playedCardsHistory = [];
        bs.extraState.playedCardsHistory.push(...parsedAiCombo.cards);
        bs.extraState.seatPlayedCards[currentSeat].push(...parsedAiCombo.cards);
        bs.extraState.playHistory.push({
          seat: currentSeat,
          cards: parsedAiCombo.cards,
          combo: authoritativeCombo,
          targetCombo,
          isPass: false,
          actionSeq: bs.actionSeq,
          timestamp: now,
        });
        bs.extraState.consecutivePasses = 0;
        if (!bs.discardsHistory) bs.discardsHistory = [];
        bs.discardsHistory.push(authoritativeCombo);

        if (bs.handsCount) {
          bs.handsCount[currentSeat] = (room as any).deal.seatCards[currentSeat].length;
        }
        if ((room as any).deal.seatCards[currentSeat].length === 0 && !finished.includes(currentSeat)) {
          if (!bs.finishedSeats) bs.finishedSeats = [];
          bs.finishedSeats.push(currentSeat);
        }

        const dealObj = (room as any).deal || {};
        const holders = detectYansanSpecialHolders(dealObj.initialSeatCards || dealObj.seatCards || [], bs.extraState.seatPlayedCards);
        const fin = bs.finishedSeats || [];
        const isQG = Boolean(bs.extraState.isQiangGongActive);
        const is2v2 = holders.spade3Seat !== holders.spadeASeat;
        let shouldEnd = false;
        if (isQG) {
          shouldEnd = fin.length >= 1;
        } else if (is2v2) {
          const isSpade = (s: number) => s === holders.spade3Seat || s === holders.spadeASeat;
          if (fin.length >= 2 && isSpade(fin[0]) === isSpade(fin[1])) shouldEnd = true;
          else if (fin.length >= 3) shouldEnd = true;
        } else {
          if (fin[0] === holders.soloSeat || fin.length >= 3) shouldEnd = true;
        }

        let afterSeat = (currentSeat - 1 + totalSeats) % totalSeats;
        let guard = 0;
        while (fin.includes(afterSeat) && guard < totalSeats) {
          afterSeat = (afterSeat - 1 + totalSeats) % totalSeats;
          guard++;
        }
        let unbeatableAutoClear = false;
        if (!shouldEnd) {
          const playedIdsAll = new Set((bs.extraState.playedCardsHistory || []).map((c: any) => c.id));
          const availablePool = createYansanStandardDeck().filter((c) => !playedIdsAll.has(c.id));
          let maxOppCards = 0;
          for (let sIdx = 0; sIdx < totalSeats; sIdx++) {
            if (sIdx !== currentSeat && !fin.includes(sIdx)) {
              maxOppCards = Math.max(maxOppCards, Number(bs.handsCount?.[sIdx] || 0));
            }
          }
          const isDeductivelyUnbeatable = isYansanComboDeductivelyUnbeatable(parsedAiCombo, availablePool, maxOppCards);
          const hasSpade3 = parsedAiCombo.cards.some((c) => c.rank === 3 && (c.suit === '♠' || c.suitVal === 4));
          if ((bs.handsCount?.[currentSeat] || 0) === 0 && (isDeductivelyUnbeatable || hasSpade3)) {
            bs.lastCombo = null;
            bs.extraState.consecutivePasses = 0;
            unbeatableAutoClear = true;
          } else if ((bs.handsCount?.[currentSeat] || 0) > 0 && isDeductivelyUnbeatable) {
            bs.lastCombo = null;
            bs.extraState.consecutivePasses = 0;
            afterSeat = currentSeat;
            unbeatableAutoClear = true;
          }
        }
        room.turnSeat = afterSeat;
        bs.turnSeat = afterSeat;

        const evtPayload = {
          action: 'play',
          seat: currentSeat,
          autoPlay: true,
          combo: authoritativeCombo,
          cardsCount: parsedAiCombo.cards.length,
          nextTurn: afterSeat,
          finishedSeats: bs.finishedSeats,
          unbeatableAutoClear: unbeatableAutoClear || undefined,
          reason: isAbsoluteFirst ? 'timeout_first_move_diamond4' : seatHand.length === 1 ? 'baodan_auto_beat' : 'timeout_smart_play',
        };
        broadcast({
          type: 'game_event',
          roomId: room.id,
          seat: currentSeat,
          event: evtPayload,
          payload: evtPayload,
          moveCount: room.moveCount,
          boardState: bs,
        });

        if (shouldEnd) {
          resolveYansanFinish(room, fin[0] ?? currentSeat, holders);
        }
      } else {
        bs.extraState.hasPassedSeats[currentSeat] = true;
        bs.extraState.consecutivePasses = (bs.extraState.consecutivePasses || 0) + 1;
        room.moveCount = (room.moveCount || 0) + 1;
        bs.moveCount = room.moveCount;
        bs.actionSeq = (bs.actionSeq || 0) + 1;
        bs.updatedAt = now;
        bs.extraState.playHistory.push({
          seat: currentSeat,
          cards: [],
          combo: null,
          targetCombo: bs.lastCombo,
          isPass: true,
          actionSeq: bs.actionSeq,
          timestamp: now,
        });

        const activeCount = Math.max(1, totalSeats - finished.length);
        const lastLeader = bs.lastCombo?.seat;
        const leaderFinished = lastLeader !== undefined && finished.includes(lastLeader);
        const passThreshold = leaderFinished ? activeCount : Math.max(1, activeCount - 1);
        if (bs.extraState.consecutivePasses >= passThreshold) {
          bs.lastCombo = null;
          bs.extraState.consecutivePasses = 0;
        }
        room.turnSeat = nextSeat;
        bs.turnSeat = nextSeat;

        broadcast({
          type: 'game_event',
          roomId: room.id,
          seat: currentSeat,
          event: {
            action: 'pass',
            seat: currentSeat,
            autoPass: true,
            nextTurn: nextSeat,
            reason: 'timeout_pass',
          },
          payload: {
            action: 'pass',
            seat: currentSeat,
            autoPass: true,
            nextTurn: nextSeat,
            reason: 'timeout_pass',
          },
          moveCount: room.moveCount,
          boardState: bs,
        });
      }
    }
  }, 1000);

  function emitBookingSettlementNotifications(notifications: SettledUserNotification[]) {
    for (const item of notifications) {
      broadcast({
        type: 'user_coins_updated',
        userId: item.userId,
        coins: item.coins,
        delta: item.delta,
        rating: item.rating,
        level: item.level,
        source: 'booking_0600_settlement',
        sceneMode: item.record.sceneMode,
        carriageNumber: item.record.carriageNumber,
        settledTablesCount: item.record.settledTablesCount,
      });
      broadcast({
        type: 'booking_0600_settled',
        userId: item.userId,
        sceneMode: item.record.sceneMode,
        record: item.record,
        coins: item.coins,
        delta: item.delta,
      });
    }
  }

  // 启动时立即检查并预先发满 50 节车厢手牌库存（库存不足 10 节自动补满 50 节）
  initServerBookingInventory()
    .then((info) => {
      console.log(
        `[ServerBooking] 十三张预约场预发牌库已就绪: 四人场 ${info.fourBookingStock} 节 / 八人场 ${info.eightBookingStock} 节`
      );
    })
    .catch((err) => {
      console.warn('[ServerBooking] 预发牌库初始化失败:', err);
    });

  // 十三张预约场每日 06:00 自动比水结算后台调度器（每30秒巡检，覆盖跨日/离线玩家）
  setTimeout(() => {
    runServer0600SettlementSweep()
      .then((list) => {
        if (list.length > 0) emitBookingSettlementNotifications(list);
      })
      .catch(() => {});
  }, 5000);

  setInterval(() => {
    runServer0600SettlementSweep()
      .then((list) => {
        if (list.length > 0) emitBookingSettlementNotifications(list);
      })
      .catch(() => {});
  }, 30000);

  // Periodic room garbage collection
  setInterval(() => {
    const now = Date.now();
    const defaultRoomIds = new Set(['RM-202', 'RM-204', 'RM-205']);
    for (const [id, room] of rooms.entries()) {
      if (!defaultRoomIds.has(id) && room.createdAt && now - room.createdAt > 3600000 && (room.spectators <= 1 || !room.players || room.players.length === 0)) {
        rooms.delete(id);
      }
    }
    for (const [id, sRoom] of sceneWaitingRooms.entries()) {
      if (sRoom.createdAt && now - sRoom.createdAt > 3600000 && (!sRoom.players || sRoom.players.length === 0)) {
        sceneWaitingRooms.delete(id);
      }
    }
  }, 600000);

  return broadcast;
}
