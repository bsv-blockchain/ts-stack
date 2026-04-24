
 (select name from output_baskets as ob where ob.basketId = o.basketId) as basket,
 (select GROUP_CONCAT(l.label SEPARATOR ',') from tx_labels as l where exists(select * from tx_labels_map as m where m.txLabelId = l.txLabelId && m.transactionId = o.transactionId)) as labels,
 (select GROUP_CONCAT(tag.tag SEPARATOR ',') from output_tags as tag where exists(select * from output_tags_map as tm where tm.outputTagId = tag.outputTagId and tm.outputId = o.outputId)) as tags,
 o.*
 from outputs as o, transactions as tx where o.spendable = true and o.transactionId = tx.transactionId and tx.status in ('completed', 'unproven', 'nosend')