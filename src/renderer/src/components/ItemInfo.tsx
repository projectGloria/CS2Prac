import { createContext, useContext, useMemo, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import type { Catalog } from '@shared/skins'
import { itemInfo, type InfoRef } from '@shared/itemInfo'
import Modal from './Modal'

/** opens the item info pop-up (Loadout page provides it; null where there is no catalog) */
export const ItemInfoContext = createContext<((ref: InfoRef) => void) | null>(null)

export const useItemInfo = () => useContext(ItemInfoContext)

/** Item info pop-up (Phase I): rows, flavour text and related items; a related item opens in the same pop-up. */
export default function ItemInfoModal(props: { catalog: Catalog; start: InfoRef; onClose: () => void }) {
  const [stack, setStack] = useState<InfoRef[]>([props.start])
  const ref = stack[stack.length - 1]
  const info = useMemo(() => itemInfo(props.catalog, ref), [props.catalog, ref])
  if (!info) return null
  return (
    <Modal title={info.title} onClose={props.onClose} wide>
      <div className="item-info">
        <div className="item-info-head" style={{ borderColor: info.rarityColor }}>
          {info.image ? <img src={info.image} alt="" draggable={false} /> : <div className="img-placeholder" />}
          <div>
            {stack.length > 1 && (
              <button className="link small" onClick={() => setStack((s) => s.slice(0, -1))}>
                <ArrowLeft size={12} /> Back
              </button>
            )}
            <div className="item-info-sub" style={{ color: info.rarityColor }}>
              {info.subtitle}
            </div>
            <table className="item-info-rows">
              <tbody>
                {info.rows.map((r) => (
                  <tr key={r.label}>
                    <th>{r.label}</th>
                    <td>{r.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        {info.flavor && <p className="item-info-flavor">“{info.flavor}”</p>}
        {info.related.map((g) => (
          <div key={g.title}>
            <h4>{g.title}</h4>
            <div className="skin-grid small-tiles">
              {g.items.map((it) => (
                <button
                  key={'id' in it.ref ? it.ref.id : it.ref.def}
                  className="skin-tile"
                  style={{ borderBottomColor: it.rarityColor }}
                  title={it.name}
                  onClick={() => setStack((s) => [...s, it.ref])}
                >
                  {it.image ? <img src={it.image} alt="" loading="lazy" draggable={false} /> : <div className="img-placeholder" />}
                  <span>{it.name}</span>
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  )
}
