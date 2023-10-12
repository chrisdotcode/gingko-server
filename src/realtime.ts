import _ from "lodash";

export type User =
  { uuid: string
  , userId: string
  , ws: WebSocket
  , m: Mode
  };

interface ViewingMode { kind: 'viewing', cardId: string };
interface EditingMode { kind: 'editing', cardId: string };

type Mode = ViewingMode | EditingMode;

type ChannelMap = Map<string, User[]>;

type MessageData =
  {
    uid: string,
    tr: string
    u: string,
    m: ['a', string] | ['e', string] | ['d', string]
  };

function disconnectUserByWS(channels : ChannelMap, ws : WebSocket) {
  for (const [treeId, users] of channels) {
    channels.set(treeId, users.filter(u => u.ws !== ws));
  }
  deleteEmptyTreeChannels(channels);
}

function broadcastToChannel(channels : ChannelMap, treeId : string, senderUuid : string, message : any) {
  const users = channels.get(treeId);
  if (users) {
    for (const u of users) {
      if (u.uuid !== senderUuid) {
        u.ws.send(JSON.stringify(message));
      }
    }
  }
}

function broadcastToChannelByWS(channels : ChannelMap, ws : WebSocket, message : any) {
  for (const [treeId, users] of channels) {
    for (const u of users) {
      if (u.ws !== ws) {
        u.ws.send(JSON.stringify(message));
      }
    }
  }
}

function deleteEmptyTreeChannels(channels : ChannelMap) {
  for (const [treeId, users] of channels) {
    if (users.length === 0) {
      channels.delete(treeId);
    }
  }
}

function updateMode(channels : ChannelMap, uuid : string, mode : ['a', string] | ['e', string] | ['d', string]) {
  for (const [treeId, users] of channels) {
    const user = users.find(u => u.uuid === uuid);
    if (user) {
      switch (mode[0]) {
        case 'a':
          user.m = { kind: 'viewing', cardId: mode[1] };
          break;
        case 'e':
          user.m = { kind: 'editing', cardId: mode[1] };
          break;
        case 'd':
          user.m = { kind: 'viewing', cardId: '' };
          break;
      }
    }
  }
}

export function handleRT(channels : ChannelMap, userId: string, msgData : MessageData) {
  updateMode(channels, msgData.uid, msgData.m);
  broadcastToChannel(channels, msgData.tr, msgData.uid,
    {
      t: 'rt',
      d: _.omit({...msgData, u: userId}, 'tr')
    });

  console.log('channels after handleRT', stringifyMField(channels));
}

function stringifyMField(channels: ChannelMap): Map<string, string[]> {
  // Create a new Map to store the results
  const result = new Map<string, string[]>();

  // Iterate over each entry in the channels
  for (const [treeId, users] of channels.entries()) {
    // Map each user's m field to a string and store in the result
    result.set(treeId, users.map(user => JSON.stringify(user.m)));
  }

  return result;
}


export function join(channels : ChannelMap, uuid : string, userId: string, ws: WebSocket, treeId : string) {
  const channelUsers = channels.get(treeId);
  const user: User = { uuid, userId, ws, m: { kind: 'viewing', cardId: '' } };

  if (channelUsers) {
    channels.set(treeId, _.uniqBy([...channelUsers, user], 'uuid'));
    const otherUsers = channelUsers.filter(u => u.uuid !== user.uuid);
    ws.send(JSON.stringify({
      t: 'rt:users',
      d: otherUsers.map(u => ({uid: u.uuid, u: u.userId, m: modeToMessage(u.m)}))
    }));
  } else {
    channels.set(treeId, [user]);
  }
  console.log('channels after join', channels);
}

function modeToMessage(m : Mode) {
  switch (m.kind) {
    case 'viewing':
      return ['a', m.cardId];
    case 'editing':
      return ['e', m.cardId];
  }
}


export function disconnectWebSocket(channels : ChannelMap, ws: WebSocket) {
  const user = [...channels.values()].flatMap(x => x).find(ci => ci.ws === ws);
  if (!user) { return; }

  broadcastToChannelByWS(channels, ws,
    {
      t: 'rt',
      d: {
        u: user.userId, uid: user.uuid, m: ["d", ""]
      }
    });
  disconnectUserByWS(channels, ws);
}