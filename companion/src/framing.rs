use crate::protocol::{Envelope, ErrorCode, HostError, MAX_MESSAGE_BYTES};
use std::io::{Read, Write};

pub fn read_envelope(reader: &mut impl Read) -> Result<Option<Envelope>, HostError> {
    let mut length_bytes = [0_u8; 4];
    let mut filled = 0;
    while filled < length_bytes.len() {
        match reader.read(&mut length_bytes[filled..]) {
            Ok(0) if filled == 0 => return Ok(None),
            Ok(0) => {
                return Err(HostError::new(
                    ErrorCode::InvalidRequest,
                    "Truncated native-message length prefix",
                ))
            }
            Ok(read) => filled += read,
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(error) => return Err(error.into()),
        }
    }

    let length = u32::from_ne_bytes(length_bytes) as usize;
    if length == 0 || length > MAX_MESSAGE_BYTES {
        return Err(HostError::new(
            ErrorCode::InvalidRequest,
            "Native message exceeds the 256 KiB limit",
        ));
    }

    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes).map_err(|_| {
        HostError::new(
            ErrorCode::InvalidRequest,
            "Truncated native-message payload",
        )
    })?;
    let envelope: Envelope = serde_json::from_slice(&bytes)
        .map_err(|_| HostError::new(ErrorCode::InvalidRequest, "Malformed JSON message"))?;
    validate_envelope(&envelope)?;
    Ok(Some(envelope))
}

pub fn write_envelope(writer: &mut impl Write, envelope: &Envelope) -> Result<(), HostError> {
    let bytes = serde_json::to_vec(envelope)?;
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(HostError::new(
            ErrorCode::Internal,
            "Refusing to emit an oversized native message",
        ));
    }
    let length = u32::try_from(bytes.len())
        .map_err(|_| HostError::new(ErrorCode::Internal, "Message length overflow"))?;
    writer.write_all(&length.to_ne_bytes())?;
    writer.write_all(&bytes)?;
    writer.flush()?;
    Ok(())
}

fn validate_envelope(envelope: &Envelope) -> Result<(), HostError> {
    if envelope.request_id.is_empty() || envelope.request_id.len() > 128 {
        return Err(HostError::new(
            ErrorCode::InvalidRequest,
            "requestId must contain between 1 and 128 characters",
        ));
    }
    if !envelope
        .request_id
        .bytes()
        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(HostError::new(
            ErrorCode::InvalidRequest,
            "requestId contains unsupported characters",
        ));
    }
    if envelope.message_type.is_empty()
        || envelope.message_type.len() > 64
        || !envelope
            .message_type
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'_')
    {
        return Err(HostError::new(
            ErrorCode::InvalidRequest,
            "Invalid native-message type",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn envelope() -> Envelope {
        Envelope {
            protocol_version: 1,
            request_id: "request-1".into(),
            message_type: "hello".into(),
            payload: json!({}),
        }
    }

    #[test]
    fn frame_round_trip_uses_native_endian_length() {
        let mut output = Vec::new();
        write_envelope(&mut output, &envelope()).unwrap();
        let expected = u32::from_ne_bytes(output[0..4].try_into().unwrap()) as usize;
        assert_eq!(expected, output.len() - 4);
        let parsed = read_envelope(&mut output.as_slice()).unwrap().unwrap();
        assert_eq!(parsed.message_type, "hello");
    }

    #[test]
    fn rejects_oversized_frame_before_allocation() {
        let mut bytes = ((MAX_MESSAGE_BYTES + 1) as u32).to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"{}");
        let error = read_envelope(&mut bytes.as_slice()).unwrap_err();
        assert_eq!(error.code, ErrorCode::InvalidRequest);
    }

    #[test]
    fn rejects_truncated_frames() {
        let mut bytes = 100_u32.to_ne_bytes().to_vec();
        bytes.extend_from_slice(b"{}");
        assert!(read_envelope(&mut bytes.as_slice()).is_err());
    }
}
