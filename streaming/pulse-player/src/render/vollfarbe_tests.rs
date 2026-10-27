//! Volle Farbaufloesung durch den ECHTEN Hochlade- und Zeichenweg.
//!
//! Hochgeladen wird mit `planes_anlegen`/`planes_fuellen` wie im Fenster,
//! gezeichnet mit derselben Pipeline und demselben Uniform-Block, 1:1 in eine
//! Textur, die dann zurueckgelesen wird. Ohne GPU uebersprungen.
//!
//! **Das Muster ist die schaerfste Kante, die es gibt**: Spalte fuer Spalte
//! abwechselnd Rot und Blau. Bei 4:4:4 muss jede Spalte ihre eigene Farbe
//! behalten; wuerde die Farbe irgendwo halbiert (Textur, Abtastung), mischten
//! sich je zwei Spalten zu Violett.

use crate::decode::{ColorMatrix, DecodedFrame, Farbangaben, PixelLayout};
use crate::proto::PlayerOptions;

use super::bildquelle::{planes_anlegen, planes_fuellen};
use super::{bind_group_aus_teilen, build_graphics, build_uniforms, geraet_oeffnen, Bildform};

const W: u32 = 64;
const H: u32 = 8;
/// BT.601, begrenzter Bereich: Rot und Blau in 8 bit (Y, Cb, Cr).
const ROT: [u16; 3] = [81, 90, 240];
const BLAU: [u16; 3] = [41, 240, 110];

/// Ein Bild in `layout` mit dem Spaltenmuster; bei 10 bit dieselben Werte
/// mal vier, in den UNTEREN Bits wie `YUV444P10LE`.
fn bild(layout: PixelLayout, zehn_bit: bool) -> DecodedFrame {
    let bps = if zehn_bit { 2 } else { 1 };
    let wert = |x: u32, k: usize| {
        let v = if x % 2 == 0 { ROT[k] } else { BLAU[k] };
        if zehn_bit { v * 4 } else { v }
    };
    let ebene = |komponenten: &[usize]| {
        let mut out = Vec::new();
        for _ in 0..H {
            for x in 0..W {
                for &k in komponenten {
                    let v = wert(x, k);
                    out.extend_from_slice(&v.to_le_bytes()[..bps]);
                }
            }
        }
        out
    };
    let zeile = (W as usize) * bps;
    let (ebenen, abstaende) = match layout {
        PixelLayout::Planar444 => (vec![ebene(&[0]), ebene(&[1]), ebene(&[2])], vec![zeile; 3]),
        PixelLayout::BiPlanar444 => (vec![ebene(&[0]), ebene(&[1, 2])], vec![zeile, 2 * zeile]),
        andere => panic!("{andere:?} ist hier nicht vorgesehen"),
    };
    let mut f = DecodedFrame::for_test(W, H, ebenen, abstaende, zehn_bit, layout);
    f.farbe = Farbangaben { matrix: ColorMatrix::Bt601, ..Farbangaben::default() };
    f
}

#[test]
fn jede_spalte_behaelt_ihre_farbe() {
    let instance = super::ohne_anzeige();
    let Ok(adapter) = pollster::block_on(instance.request_adapter(&Default::default())) else {
        eprintln!("keine GPU — 4:4:4-Zeichenweg nicht geprueft");
        return;
    };
    let Ok((device, queue, breit)) = pollster::block_on(geraet_oeffnen(&adapter, "444-test"))
    else {
        eprintln!("Geraet liess sich nicht oeffnen — 4:4:4-Zeichenweg nicht geprueft");
        return;
    };
    for (layout, zehn_bit) in [
        (PixelLayout::Planar444, false),
        (PixelLayout::Planar444, true),
        (PixelLayout::BiPlanar444, false),
    ] {
        let punkte = zeichnen(&device, &queue, &bild(layout, zehn_bit), breit);
        for (x, p) in punkte.iter().take(W as usize).enumerate() {
            // Rot hat R voll und B leer, Blau umgekehrt; gemischt laege beides
            // um die Mitte. Toleranz fuer Rundung und die Farbmatrix.
            let (r, b) = (p[0], p[2]);
            let soll_rot = x % 2 == 0;
            assert!(
                if soll_rot { r > 245 && b < 10 } else { r < 10 && b > 245 },
                "{layout:?} zehn_bit={zehn_bit}, Spalte {x}: RGB {p:?}, soll {}",
                if soll_rot { "Rot" } else { "Blau" }
            );
        }
    }
}

/// Hochladen wie das Fenster, 1:1 zeichnen, die erste Zeile zuruecklesen.
fn zeichnen(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    f: &DecodedFrame,
    breit: bool,
) -> Vec<[u8; 4]> {
    let format = wgpu::TextureFormat::Rgba8Unorm;
    let planes = planes_anlegen(device, f, breit);
    let mut scratch: [Vec<u8>; 3] = Default::default();
    planes_fuellen(queue, &planes, f, breit, &mut scratch);

    let gfx = build_graphics(device, format);
    let opts = PlayerOptions { deband: Some(0.0), dither: Some(false), ..Default::default() };
    let form = Bildform::voll(planes.layout, planes.ten_bit, planes.wide);
    let uniforms = build_uniforms(format, form, &opts, false, f.farbe, false, 0.0);
    queue.write_buffer(&gfx.uniform_buf, 0, &uniforms.as_bytes());
    let ansicht = |t: &wgpu::Texture| t.create_view(&wgpu::TextureViewDescriptor::default());
    let (vy, vu, vv) = (ansicht(&planes.y), ansicht(&planes.u), ansicht(&planes.v));
    let bind =
        bind_group_aus_teilen(device, &gfx.bind_layout, &gfx.sampler, &gfx.uniform_buf, [&vy, &vu, &vv]);

    let ziel = super::bildquelle::textur(
        device,
        W,
        H,
        format,
        wgpu::TextureUsages::RENDER_ATTACHMENT | wgpu::TextureUsages::COPY_SRC,
        "444-ziel",
    );
    // 64 Punkte zu 4 Byte = 256 Byte, also schon richtig ausgerichtet.
    let zeile = W * 4;
    let lese = device.create_buffer(&wgpu::BufferDescriptor {
        label: Some("444-lesen"),
        size: u64::from(zeile * H),
        usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
        mapped_at_creation: false,
    });
    let mut enc = device.create_command_encoder(&Default::default());
    {
        let zielansicht = ansicht(&ziel);
        let mut pass = enc.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("444-pass"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &zielansicht,
                resolve_target: None,
                depth_slice: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::BLACK),
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&gfx.pipeline);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..3, 0..1);
    }
    enc.copy_texture_to_buffer(
        ziel.as_image_copy(),
        wgpu::TexelCopyBufferInfo {
            buffer: &lese,
            layout: wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(zeile),
                rows_per_image: Some(H),
            },
        },
        wgpu::Extent3d { width: W, height: H, depth_or_array_layers: 1 },
    );
    queue.submit(Some(enc.finish()));
    let slice = lese.slice(..);
    slice.map_async(wgpu::MapMode::Read, |_| {});
    device.poll(wgpu::PollType::wait_indefinitely()).expect("GPU-Warten");
    let roh = slice.get_mapped_range().expect("Lesepuffer");
    roh.chunks_exact(4).map(|p| [p[0], p[1], p[2], p[3]]).collect()
}
