//! App ↔ Hub encryption, independent of terminal input mode and relay provider.
//!
//! Cryptography and nonce handling belong to Snow's standard Noise IK pattern.
//! The QR-pinned Hub key authenticates the server; the client's encrypted static
//! key identifies its revocable device. No application data enters handshake
//! payloads: authentication/pairing happens in the transport phase.
use snow::{Builder, HandshakeState, TransportState};
use zeroize::Zeroizing;

pub mod client;
pub mod messages;
pub mod outbound;
pub mod pairing;
pub mod routes;
pub mod wire;

pub const NOISE_PATTERN: &str = "Noise_IK_25519_ChaChaPoly_SHA256";
pub const PROLOGUE: &[u8] = b"offdesk-secure-v2";
pub const MAX_RECORD: usize = 65_535;
pub const MAX_PLAINTEXT_RECORD: usize = MAX_RECORD - 16;
pub const MAX_MESSAGE: usize = 32 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Secure handshake or authentication failed")]
    Noise(#[from] snow::Error),
    #[error("Encrypted message is too large")]
    TooLarge,
    #[error("Malformed encrypted message")]
    InvalidMessage,
    #[error("Secure channel has failed; reconnect before sending")]
    Closed,
}

/// Intentionally not Debug or Serialize: private keys must never enter logs.
pub struct Identity {
    private: Zeroizing<Vec<u8>>,
    public: [u8; 32],
}
impl Identity {
    pub fn generate() -> Result<Self, Error> {
        let pair = builder().generate_keypair()?;
        Ok(Self {
            private: Zeroizing::new(pair.private),
            public: pair.public.try_into().map_err(|_| Error::InvalidMessage)?,
        })
    }
    pub fn from_private(private: &[u8]) -> Result<Self, Error> {
        // Recover the public key through the same primitive used by Snow.
        // A temporary NN handshake's ephemeral key is not a static key, so
        // never substitute handshake output for the public-key derivation.
        if private.len() != 32 {
            return Err(Error::InvalidMessage);
        }
        let mut dh = snow::resolvers::DefaultResolver::default()
            .resolve_dh(&snow::params::DHChoice::Curve25519)
            .ok_or(Error::InvalidMessage)?;
        dh.set(private);
        let public = dh.pubkey().try_into().map_err(|_| Error::InvalidMessage)?;
        Ok(Self {
            private: Zeroizing::new(private.to_vec()),
            public,
        })
    }
    pub fn public(&self) -> &[u8; 32] {
        &self.public
    }
    /// Only for the native credential store / Hub's protected key file.
    pub fn private_for_storage(&self) -> &[u8] {
        &self.private
    }
    pub fn initiator(&self, pinned_hub: &[u8; 32]) -> Result<HandshakeState, Error> {
        Ok(builder()
            .local_private_key(&self.private)?
            .remote_public_key(pinned_hub)?
            .prologue(PROLOGUE)?
            .build_initiator()?)
    }
    pub fn responder(&self) -> Result<HandshakeState, Error> {
        Ok(builder()
            .local_private_key(&self.private)?
            .prologue(PROLOGUE)?
            .build_responder()?)
    }
}
use snow::resolvers::CryptoResolver;
fn builder<'a>() -> Builder<'a> {
    Builder::new(NOISE_PATTERN.parse().expect("fixed Noise pattern"))
}

/// One authenticated fragment per Noise record. Independent messages may be
/// interleaved, while offsets and Noise nonces preserve each message's order.
/// IDs, lengths and offsets are encrypted; the relay sees no stream metadata.
pub const FRAGMENT_BYTES: usize = 16 * 1024;
const HEADER_BYTES: usize = 16;
const MAX_ASSEMBLIES: usize = 8;
const MAX_ASSEMBLY_BYTES: usize = 64 * 1024 * 1024;

pub struct OutgoingMessage {
    data: Vec<u8>,
    offset: usize,
    id: Option<u64>,
}
impl OutgoingMessage {
    pub fn new(data: Vec<u8>) -> Result<Self, Error> {
        if data.is_empty() || data.len() > MAX_MESSAGE {
            return Err(Error::TooLarge);
        }
        Ok(Self {
            data,
            offset: 0,
            id: None,
        })
    }
    pub fn finished(&self) -> bool {
        self.offset == self.data.len()
    }
    pub fn is_small(&self) -> bool {
        self.data.len() <= FRAGMENT_BYTES
    }
}
struct Assembly {
    total: usize,
    data: Vec<u8>,
}
pub struct Channel {
    noise: TransportState,
    next_id: u64,
    last_started: u64,
    pending: std::collections::HashMap<u64, Assembly>,
    reserved: usize,
    failed: bool,
}
impl Channel {
    pub fn new(noise: TransportState) -> Self {
        Self {
            noise,
            next_id: 1,
            last_started: 0,
            pending: Default::default(),
            reserved: 0,
            failed: false,
        }
    }
    /// Encrypt only when this fragment is selected for transmission. Encrypting
    /// all fragments up front would make interleaved records reuse/reorder nonces.
    pub fn encode_next(&mut self, message: &mut OutgoingMessage) -> Result<Vec<u8>, Error> {
        if self.failed {
            return Err(Error::Closed);
        }
        if message.finished() {
            return Err(Error::InvalidMessage);
        }
        let id = match message.id {
            Some(id) => id,
            None => {
                let id = self.next_id;
                self.next_id = self.next_id.checked_add(1).ok_or(Error::Closed)?;
                message.id = Some(id);
                id
            }
        };
        let end = (message.offset + FRAGMENT_BYTES).min(message.data.len());
        let mut plain = Vec::with_capacity(HEADER_BYTES + end - message.offset);
        plain.extend_from_slice(&id.to_be_bytes());
        plain.extend_from_slice(&(message.data.len() as u32).to_be_bytes());
        plain.extend_from_slice(&(message.offset as u32).to_be_bytes());
        plain.extend_from_slice(&message.data[message.offset..end]);
        let mut record = vec![0; plain.len() + 16];
        match self.noise.write_message(&plain, &mut record) {
            Ok(n) => {
                record.truncate(n);
                message.offset = end;
                Ok(record)
            }
            Err(error) => {
                self.failed = true;
                Err(error.into())
            }
        }
    }
    /// Convenience for small authentication messages / non-interleaved tests.
    pub fn encode(&mut self, message: &[u8]) -> Result<Vec<Vec<u8>>, Error> {
        let mut message = OutgoingMessage::new(message.to_vec())?;
        let mut records = Vec::new();
        while !message.finished() {
            records.push(self.encode_next(&mut message)?);
        }
        Ok(records)
    }
    pub fn decode(&mut self, record: &[u8]) -> Result<Vec<Vec<u8>>, Error> {
        if self.failed {
            return Err(Error::Closed);
        }
        let result = self.decode_inner(record);
        if result.is_err() {
            self.failed = true;
            self.pending.clear();
            self.reserved = 0;
        }
        result
    }
    fn decode_inner(&mut self, record: &[u8]) -> Result<Vec<Vec<u8>>, Error> {
        if !(HEADER_BYTES + 17..=HEADER_BYTES + FRAGMENT_BYTES + 16).contains(&record.len()) {
            return Err(Error::InvalidMessage);
        }
        let mut plain = vec![0; record.len()];
        let n = self.noise.read_message(record, &mut plain)?;
        if n <= HEADER_BYTES {
            return Err(Error::InvalidMessage);
        }
        let id = u64::from_be_bytes(plain[..8].try_into().unwrap());
        let total = u32::from_be_bytes(plain[8..12].try_into().unwrap()) as usize;
        let offset = u32::from_be_bytes(plain[12..16].try_into().unwrap()) as usize;
        let data = &plain[HEADER_BYTES..n];
        if total == 0
            || total > MAX_MESSAGE
            || offset.checked_add(data.len()).is_none_or(|end| end > total)
        {
            return Err(Error::TooLarge);
        }
        if offset == 0 {
            if id <= self.last_started {
                return Err(Error::InvalidMessage);
            }
            self.last_started = id;
            if data.len() == total {
                return Ok(vec![data.to_vec()]);
            }
            if self.pending.len() >= MAX_ASSEMBLIES || self.reserved + total > MAX_ASSEMBLY_BYTES {
                return Err(Error::TooLarge);
            }
            self.reserved += total;
            self.pending.insert(
                id,
                Assembly {
                    total,
                    data: data.to_vec(),
                },
            );
            return Ok(Vec::new());
        }
        let assembly = self.pending.get_mut(&id).ok_or(Error::InvalidMessage)?;
        if assembly.total != total || assembly.data.len() != offset {
            return Err(Error::InvalidMessage);
        }
        assembly.data.extend_from_slice(data);
        if assembly.data.len() == total {
            self.reserved -= total;
            return Ok(vec![self.pending.remove(&id).unwrap().data]);
        }
        Ok(Vec::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    pub(crate) fn handshake() -> (Channel, Channel) {
        let client = Identity::generate().unwrap();
        let hub = Identity::generate().unwrap();
        let mut a = client.initiator(hub.public()).unwrap();
        let mut b = hub.responder().unwrap();
        let mut wire = [0; MAX_RECORD];
        let mut plain = [0; MAX_RECORD];
        let n = a.write_message(&[], &mut wire).unwrap();
        assert_eq!(b.read_message(&wire[..n], &mut plain).unwrap(), 0);
        let n = b.write_message(&[], &mut wire).unwrap();
        assert_eq!(a.read_message(&wire[..n], &mut plain).unwrap(), 0);
        assert_eq!(b.get_remote_static().unwrap(), client.public());
        assert_eq!(a.get_handshake_hash(), b.get_handshake_hash());
        (
            Channel::new(a.into_transport_mode().unwrap()),
            Channel::new(b.into_transport_mode().unwrap()),
        )
    }
    #[test]
    fn identity_restores_the_same_public_key() {
        let identity = Identity::generate().unwrap();
        let restored = Identity::from_private(identity.private_for_storage()).unwrap();
        assert_eq!(identity.public(), restored.public());
    }
    #[test]
    fn messages_round_trip_with_fragmented_images_and_directional_keys() {
        let (mut a, mut b) = handshake();
        let message = vec![123; 20 * 1024 * 1024];
        let mut received = Vec::new();
        for record in a.encode(&message).unwrap() {
            assert!(record.len() <= MAX_RECORD);
            received.extend(b.decode(&record).unwrap());
        }
        assert_eq!(received, vec![message]);
        let reply = b.encode(b"acknowledgement").unwrap();
        assert_eq!(
            a.decode(&reply[0]).unwrap(),
            vec![b"acknowledgement".to_vec()]
        );
    }
    #[test]
    fn tampering_and_replay_poison_the_channel() {
        let (mut a, mut b) = handshake();
        let mut record = a.encode(b"a terminal command").unwrap().remove(0);
        assert_eq!(b.decode(&record).unwrap().len(), 1);
        assert!(b.decode(&record).is_err());
        assert!(matches!(b.decode(&record), Err(Error::Closed)));
        let (mut a, mut b) = handshake();
        record = a.encode(b"another command").unwrap().remove(0);
        record[3] ^= 1;
        assert!(b.decode(&record).is_err());
    }
    #[test]
    fn a_relay_cannot_substitute_another_hub_key() {
        let client = Identity::generate().unwrap();
        let hub = Identity::generate().unwrap();
        let attacker = Identity::generate().unwrap();
        let mut initiator = client.initiator(hub.public()).unwrap();
        let mut impostor = attacker.responder().unwrap();
        let mut wire = [0; MAX_RECORD];
        let n = initiator.write_message(&[], &mut wire).unwrap();
        assert!(impostor
            .read_message(&wire[..n], &mut [0; MAX_RECORD])
            .is_err());
    }
    #[test]
    fn the_unreleased_v1_transport_cannot_negotiate_v2_framing() {
        let client = Identity::generate().unwrap();
        let hub = Identity::generate().unwrap();
        let mut old = builder()
            .local_private_key(client.private_for_storage())
            .unwrap()
            .remote_public_key(hub.public())
            .unwrap()
            .prologue(b"offdesk-secure-v1")
            .unwrap()
            .build_initiator()
            .unwrap();
        let mut current = hub.responder().unwrap();
        let mut wire = [0; MAX_RECORD];
        let n = old.write_message(&[], &mut wire).unwrap();
        assert!(current
            .read_message(&wire[..n], &mut [0; MAX_RECORD])
            .is_err());
    }
    #[test]
    fn records_cannot_be_reordered_or_moved_to_another_connection() {
        let (mut a, mut b) = handshake();
        let first = a.encode(b"one").unwrap().remove(0);
        let second = a.encode(b"two").unwrap().remove(0);
        assert!(b.decode(&second).is_err());
        let (_, mut other) = handshake();
        assert!(other.decode(&first).is_err());
    }

    #[test]
    fn independent_messages_interleave_without_corrupting_a_large_message() {
        let (mut sender, mut receiver) = handshake();
        let data = vec![42; FRAGMENT_BYTES * 3 + 7];
        let mut bulk = OutgoingMessage::new(data.clone()).unwrap();
        assert!(receiver
            .decode(&sender.encode_next(&mut bulk).unwrap())
            .unwrap()
            .is_empty());
        for text in [b"heartbeat".as_slice(), b"other terminal input"] {
            let record = sender.encode(text).unwrap().remove(0);
            assert_eq!(receiver.decode(&record).unwrap(), vec![text.to_vec()]);
        }
        let mut received = Vec::new();
        while !bulk.finished() {
            received.extend(
                receiver
                    .decode(&sender.encode_next(&mut bulk).unwrap())
                    .unwrap(),
            );
        }
        assert_eq!(received, vec![data]);
        assert_eq!(receiver.reserved, 0);
        assert!(receiver.pending.is_empty());
    }

    #[test]
    fn authenticated_fragment_offsets_and_assembly_budgets_are_enforced() {
        let (mut sender, mut receiver) = handshake();
        let mut bulk = OutgoingMessage::new(vec![9; FRAGMENT_BYTES * 2]).unwrap();
        receiver
            .decode(&sender.encode_next(&mut bulk).unwrap())
            .unwrap();
        // Authenticated but invalid continuation, as a malicious peer might send.
        let mut plain = Vec::new();
        plain.extend_from_slice(&1u64.to_be_bytes());
        plain.extend_from_slice(&((FRAGMENT_BYTES * 2) as u32).to_be_bytes());
        plain.extend_from_slice(&99u32.to_be_bytes());
        plain.push(7);
        let mut wire = vec![0; plain.len() + 16];
        sender.noise.write_message(&plain, &mut wire).unwrap();
        assert!(receiver.decode(&wire).is_err());
        assert!(matches!(receiver.decode(&wire), Err(Error::Closed)));
        assert_eq!(receiver.reserved, 0);
        let (mut sender, mut receiver) = handshake();
        for _ in 0..MAX_ASSEMBLIES {
            let mut bulk = OutgoingMessage::new(vec![1; FRAGMENT_BYTES + 1]).unwrap();
            receiver
                .decode(&sender.encode_next(&mut bulk).unwrap())
                .unwrap();
        }
        let mut excess = OutgoingMessage::new(vec![1; FRAGMENT_BYTES + 1]).unwrap();
        assert!(matches!(
            receiver.decode(&sender.encode_next(&mut excess).unwrap()),
            Err(Error::TooLarge)
        ));
        let (mut sender, mut receiver) = handshake();
        // Even fewer than eight assemblies cannot reserve unlimited totals.
        for id in 1u64..=3 {
            let mut plain = Vec::new();
            plain.extend_from_slice(&id.to_be_bytes());
            plain.extend_from_slice(&(MAX_MESSAGE as u32).to_be_bytes());
            plain.extend_from_slice(&0u32.to_be_bytes());
            plain.push(1);
            let mut record = vec![0; plain.len() + 16];
            sender.noise.write_message(&plain, &mut record).unwrap();
            if id <= 2 {
                assert!(receiver.decode(&record).is_ok());
            } else {
                assert!(matches!(receiver.decode(&record), Err(Error::TooLarge)));
            }
        }
    }
}
